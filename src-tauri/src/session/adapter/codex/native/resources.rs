//! Native MCP and skill discovery under the session's effective Codex config.
use super::{
    protocol,
    runtime::Inner,
    transport::{self, Transport},
};
use crate::ipc::{AppError, ErrorCode};
use crate::session::application::{ResourceRequest, TurnContext};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

impl Inner {
    pub(super) fn resource(&self, request: ResourceRequest) -> Result<Value, AppError> {
        let (connection, ctx, thread) = {
            let state = self.state.lock().unwrap();
            if state.closed {
                return Err(transport::unavailable());
            }
            (
                state.transport.clone().ok_or_else(transport::unavailable)?,
                state
                    .turn
                    .as_ref()
                    .ok_or_else(transport::unavailable)?
                    .context
                    .clone(),
                state.thread_id.clone(),
            )
        };
        dispatch(&connection, &ctx, thread.as_deref(), request)
    }
}
pub(crate) fn probe(ctx: &TurnContext, request: ResourceRequest) -> Result<Value, AppError> {
    let connection = Transport::spawn(ctx, Arc::new(|_| {}))?;
    let result = (|| {
        connection.call(Transport::deadline(), |id| {
            Ok(protocol::initialize(id, env!("CARGO_PKG_VERSION")))
        })?;
        connection.write(&json!({"method":"initialized"}))?;
        dispatch(&connection, ctx, None, request)
    })();
    connection.close();
    result
}
fn dispatch(
    connection: &Arc<Transport>,
    ctx: &TurnContext,
    thread: Option<&str>,
    request: ResourceRequest,
) -> Result<Value, AppError> {
    let cwd = super::invocation::native_path(ctx, &ctx.cwd)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    resource_with(&cwd, thread, request, |method, params| {
        connection.call(deadline, |id| Ok(protocol::request(id, method, params)))
    })
}
fn failure(code: ErrorCode, message: &str) -> AppError {
    AppError::new(code, message)
}
fn skills(
    cwd: &str,
    call: &mut impl FnMut(&str, Value) -> Result<Value, AppError>,
) -> Result<Vec<Value>, AppError> {
    let result = call("skills/list", json!({"cwds":[cwd],"forceReload":true}))?;
    let entries = result["data"]
        .as_array()
        .ok_or_else(transport::protocol_error)?;
    let mut out = Vec::new();
    for entry in entries {
        if entry["errors"]
            .as_array()
            .is_some_and(|errors| !errors.is_empty())
        {
            return Err(failure(
                ErrorCode::SkillError,
                "Codex could not load every skill; check its skill files",
            ));
        }
        for skill in entry["skills"]
            .as_array()
            .ok_or_else(transport::protocol_error)?
        {
            out.push(skill_info(skill)?);
        }
    }
    Ok(out)
}
fn skill_info(skill: &Value) -> Result<Value, AppError> {
    let name = skill["name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .ok_or_else(transport::protocol_error)?;
    let path = skill["path"]
        .as_str()
        .filter(|path| !path.is_empty())
        .ok_or_else(transport::protocol_error)?;
    let enabled = skill["enabled"]
        .as_bool()
        .ok_or_else(transport::protocol_error)?;
    let native_scope = skill["scope"]
        .as_str()
        .ok_or_else(transport::protocol_error)?;
    let scope = if skill["pluginId"].is_string() {
        "plugin"
    } else {
        match native_scope {
            "repo" => "project",
            "user" => "user",
            _ => "path",
        }
    };
    Ok(
        json!({"name":name,"description":skill["description"].as_str().unwrap_or(""),
        "installed":enabled,"loaded":enabled,"scope":scope,"kind":"skill","pluginId":skill["pluginId"],
        "invocation":format!("${name}"),"source":"skill","sourcePath":path}),
    )
}
fn mcp_inventory(
    thread: Option<&str>,
    call: &mut impl FnMut(&str, Value) -> Result<Value, AppError>,
) -> Result<Vec<Value>, AppError> {
    let mut rows = Vec::new();
    let mut cursor = Value::Null;
    let mut seen = std::collections::HashSet::new();
    for _ in 0..64 {
        let reply = call(
            "mcpServerStatus/list",
            json!({"threadId":thread,"cursor":cursor,"limit":100,"detail":"full"}),
        )?;
        rows.extend(
            reply["data"]
                .as_array()
                .ok_or_else(transport::protocol_error)?
                .iter()
                .cloned(),
        );
        cursor = reply
            .get("nextCursor")
            .cloned()
            .ok_or_else(transport::protocol_error)?;
        if cursor.is_null() {
            return Ok(rows);
        }
        let next = cursor
            .as_str()
            .filter(|cursor| !cursor.is_empty())
            .ok_or_else(transport::protocol_error)?;
        if !seen.insert(next.to_string()) {
            return Err(transport::protocol_error());
        }
    }
    Err(failure(
        ErrorCode::McpError,
        "Codex MCP inventory exceeded its page limit",
    ))
}
fn mcp_info(
    native: &Value,
    config: Option<&Value>,
    scope: Option<&str>,
) -> Result<Value, AppError> {
    let name = native["name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .ok_or_else(transport::protocol_error)?;
    let status = match native["runtimeStatus"].as_str() {
        Some("connected") => "connected",
        Some("starting") => "connecting",
        Some("failed") => "error",
        Some("authenticationRequired") => "pending",
        Some("disabled" | "cancelled") => "rejected",
        Some("notStarted") | None => {
            if config.is_some_and(|c| c["enabled"] == false) {
                "rejected"
            } else if native["authStatus"] == "notLoggedIn" {
                "pending"
            } else {
                "approved"
            }
        }
        _ => return Err(transport::protocol_error()),
    };
    let mut info = json!({"name":name,"status":status});
    if let Some(scope) = scope {
        info["scope"] = json!(scope);
    }
    if status == "connected" {
        info["toolCount"] = json!(native["tools"].as_object().map_or(0, |tools| tools.len()));
    }
    if status == "error" {
        info["errorMessage"] = json!("Codex could not connect this MCP server");
    }
    if native["toolsError"].is_string() {
        info["errorMessage"] = json!("Codex could not discover this server's tools");
    }
    Ok(info)
}
fn layer_for<'a>(config: &'a Value, name: &str) -> Option<&'a Value> {
    config["layers"].as_array()?.iter().rev().find(|layer| {
        layer["disabledReason"].is_null() && layer["config"]["mcp_servers"].get(name).is_some()
    })
}
fn scope_of(config: &Value, name: &str) -> &'static str {
    if layer_for(config, name).is_some_and(|layer| layer["name"]["type"] == "project") {
        "project"
    } else {
        "user"
    }
}
fn write_servers(
    config: &Value,
    name: Option<&str>,
    mutate: impl FnOnce(&mut serde_json::Map<String, Value>),
    call: &mut impl FnMut(&str, Value) -> Result<Value, AppError>,
) -> Result<(), AppError> {
    let layer = name.and_then(|name| layer_for(config, name)).or_else(|| {
        config["layers"]
            .as_array()
            .and_then(|layers| layers.iter().find(|layer| layer["name"]["type"] == "user"))
    });
    let mut params = json!({"keyPath":"mcp_servers","mergeStrategy":"replace"});
    if let Some(layer) = layer {
        match layer["name"]["type"].as_str() {
            Some("user") => {
                params["filePath"] = layer["name"]["file"].clone();
            }
            Some("project") => {
                let dir = layer["name"]["dotCodexFolder"]
                    .as_str()
                    .ok_or_else(transport::protocol_error)?;
                params["filePath"] = json!(format!("{}/config.toml", dir.trim_end_matches('/')));
            }
            _ => {
                return Err(failure(
                    ErrorCode::McpError,
                    "This MCP server is managed outside writable Codex configuration",
                ))
            }
        }
        params["expectedVersion"] = layer["version"].clone();
    }
    // Only mutate the owning file's table. Effective project values must never
    // be copied into an account's global configuration.
    let source = layer.or_else(|| {
        config["layers"]
            .as_array()
            .and_then(|layers| layers.iter().find(|l| l["name"]["type"] == "user"))
    });
    let mut servers = source
        .map(|l| &l["config"]["mcp_servers"])
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    mutate(&mut servers);
    params["value"] = Value::Object(servers);
    call("config/value/write", params)?;
    call("config/mcpServer/reload", Value::Null)?;
    Ok(())
}
fn attach_config(entry: &Value) -> Result<(String, Value), AppError> {
    let name = entry["name"].as_str().unwrap_or("").trim();
    if name.is_empty() {
        return Err(failure(ErrorCode::InvalidInput, "Server name is required"));
    }
    let secret = entry.get("secretParams").filter(|value| value.is_object());
    let config = match entry["transport"].as_str().unwrap_or("stdio") {
        "http" => {
            let url = entry["url"].as_str().unwrap_or("").trim();
            if url.is_empty() {
                return Err(failure(
                    ErrorCode::InvalidInput,
                    "URL is required for an HTTP server",
                ));
            }
            let mut value = json!({"url":url});
            if let Some(headers) = secret {
                value["http_headers"] = headers.clone();
            }
            value
        }
        "stdio" => {
            let command = entry["command"].as_str().unwrap_or("").trim();
            if command.is_empty() {
                return Err(failure(
                    ErrorCode::InvalidInput,
                    "Command is required for a stdio server",
                ));
            }
            let args = crate::profiles::parse_extra_args(command)
                .map_err(|_| failure(ErrorCode::InvalidInput, "Invalid MCP command quoting"))?;
            if args.first().is_none_or(|command| command.is_empty()) {
                return Err(failure(ErrorCode::InvalidInput, "MCP command is required"));
            }
            let mut value = json!({"command":args.first(),"args":&args[1..]});
            if let Some(env) = secret {
                value["env"] = env.clone();
            }
            value
        }
        _ => return Err(failure(ErrorCode::InvalidInput, "Unknown MCP transport")),
    };
    Ok((name.to_string(), config))
}
fn resource_with(
    cwd: &str,
    thread: Option<&str>,
    request: ResourceRequest,
    mut call: impl FnMut(&str, Value) -> Result<Value, AppError>,
) -> Result<Value, AppError> {
    match request {
        ResourceRequest::RemoteStart(_)
        | ResourceRequest::RemoteStop
        | ResourceRequest::RemoteGet => {
            return Err(failure(
                ErrorCode::RuntimeUnsupported,
                "Remote control requires the session's live native connection",
            ))
        }
        ResourceRequest::RequestUrl(_) | ResourceRequest::AgentStop(_) => {
            return Err(failure(
                ErrorCode::RuntimeUnsupported,
                "Agent control is not a resource discovery request",
            ))
        }
        ResourceRequest::SkillsList => return Ok(Value::Array(skills(cwd, &mut call)?)),
        ResourceRequest::SkillEnable(name) => {
            let matches = skills(cwd, &mut call)?
                .into_iter()
                .filter(|skill| skill["name"] == name)
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return Err(failure(
                    ErrorCode::SkillError,
                    "Select one unambiguous native Codex skill",
                ));
            }
            call(
                "skills/config/write",
                json!({"path":matches[0]["sourcePath"],"enabled":true}),
            )?;
            return Ok(Value::Null);
        }
        _ => {}
    }
    let config = call("config/read", json!({"cwd":cwd,"includeLayers":true}))?;
    let servers = config["config"]
        .get("mcp_servers")
        .and_then(Value::as_object);
    match request {
        ResourceRequest::McpAttach(entry) => {
            let (name, value) = attach_config(&entry)?;
            if servers.is_some_and(|servers| servers.contains_key(&name)) {
                return Err(failure(
                    ErrorCode::InvalidInput,
                    "This server already exists in Codex configuration",
                ));
            }
            write_servers(
                &config,
                None,
                |servers| {
                    servers.insert(name, value);
                },
                &mut call,
            )?;
            Ok(Value::Null)
        }
        ResourceRequest::McpDetach(name) => {
            if !servers.is_some_and(|servers| servers.contains_key(&name)) {
                return Err(failure(
                    ErrorCode::McpError,
                    "This server is not configured in Codex",
                ));
            }
            let inherited = layer_for(&config, &name)
                .and_then(|layer| layer["name"]["file"].as_str())
                .is_some_and(|file| crate::account::codex_server_inherited(file, &name));
            let overlapping_layers = config["layers"].as_array().map_or(0, |layers| {
                layers
                    .iter()
                    .filter(|layer| {
                        layer["disabledReason"].is_null()
                            && layer["config"]["mcp_servers"].get(&name).is_some()
                    })
                    .count()
            }) > 1;
            let disabled = servers.and_then(|servers| servers.get(&name)).cloned();
            write_servers(
                &config,
                Some(&name),
                |servers| {
                    if inherited || overlapping_layers {
                        if let Some(mut entry) = disabled {
                            entry["enabled"] = json!(false);
                            servers.insert(name.clone(), entry);
                        }
                    } else {
                        servers.remove(&name);
                    }
                },
                &mut call,
            )?;
            Ok(Value::Null)
        }
        ResourceRequest::McpReconnect(name) => {
            if let Some(entry) = servers
                .and_then(|servers| servers.get(&name))
                .filter(|entry| entry["enabled"] == false)
            {
                let mut entry = entry.clone();
                entry["enabled"] = json!(true);
                write_servers(
                    &config,
                    Some(&name),
                    |servers| {
                        servers.insert(name.clone(), entry);
                    },
                    &mut call,
                )?;
            }
            let rows = mcp_inventory(thread, &mut call)?;
            let row = rows.iter().find(|server| server["name"] == name);
            if !servers.is_some_and(|servers| servers.contains_key(&name)) && row.is_none() {
                return Err(failure(
                    ErrorCode::McpError,
                    "This server is not visible to Codex",
                ));
            }
            if row.is_some_and(|server| {
                server["runtimeStatus"] == "authenticationRequired"
                    || server["authStatus"] == "notLoggedIn"
            }) {
                let thread = thread.ok_or_else(||failure(ErrorCode::RuntimeUnavailable,"Start a Codex turn before connecting this server, so its native login callback remains available"))?;
                let result = call(
                    "mcpServer/oauth/login",
                    json!({"name":name,"threadId":thread}),
                )?;
                if !result["authorizationUrl"].is_string() {
                    return Err(transport::protocol_error());
                }
                return Ok(json!({"authorizationUrl":result["authorizationUrl"]}));
            }
            call("config/mcpServer/reload", Value::Null)?;
            Ok(Value::Null)
        }
        ResourceRequest::McpList | ResourceRequest::McpDetail(_) => {
            let mut rows = mcp_inventory(thread, &mut call)?;
            if let Some(servers) = servers {
                for name in servers.keys() {
                    if !rows.iter().any(|row| row["name"] == *name) {
                        rows.push(json!({"name":name,"runtimeStatus":null}));
                    }
                }
            }
            if let ResourceRequest::McpDetail(name) = request {
                let row = rows.iter().find(|row| row["name"] == name).ok_or_else(|| {
                    failure(ErrorCode::McpError, "This server is not visible to Codex")
                })?;
                let entry = servers.and_then(|servers| servers.get(&name));
                let mut info = mcp_info(row, entry, entry.map(|_| scope_of(&config, &name)))?;
                let http = entry.is_some_and(|entry| entry["url"].is_string())
                    || row["httpOrigin"].is_string();
                info["transport"] = json!(if http { "http" } else { "stdio" });
                if http {
                    info["url"] = entry
                        .and_then(|e| e.get("url"))
                        .cloned()
                        .unwrap_or_else(|| row["httpOrigin"].clone());
                } else if let Some(entry) = entry {
                    info["command"] = json!(crate::session::mcp::command_of(entry));
                }
                return Ok(info);
            }
            rows.iter()
                .map(|row| {
                    let name = row["name"].as_str().ok_or_else(transport::protocol_error)?;
                    let entry = servers.and_then(|servers| servers.get(name));
                    mcp_info(row, entry, entry.map(|_| scope_of(&config, name)))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        _ => unreachable!(),
    }
}
pub(super) fn skill_inputs(
    connection: &Arc<Transport>,
    ctx: &TurnContext,
    text: &str,
) -> Result<Vec<Value>, AppError> {
    let Some(name) = text
        .split_whitespace()
        .next()
        .and_then(|token| token.strip_prefix('$'))
        .filter(|name| !name.is_empty())
    else {
        return Ok(Vec::new());
    };
    let cwd = super::invocation::native_path(ctx, &ctx.cwd)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let skills = skills(&cwd, &mut |method, params| {
        connection.call(deadline, |id| Ok(protocol::request(id, method, params)))
    })?;
    let matches = skills
        .iter()
        .filter(|skill| skill["name"] == name && skill["installed"] == true)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Ok(Vec::new()),
        [skill] => Ok(vec![
            json!({"type":"skill","name":name,"path":skill["sourcePath"]}),
        ]),
        _ => Err(failure(
            ErrorCode::SkillError,
            "Several enabled skills share this name; select an unambiguous skill",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_oauth_requires_live_thread_and_returns_the_native_browser_url() {
        for thread in [None, Some("owned-thread")] {
            let mut oauth = false;
            let result = resource_with(
                "/project",
                thread,
                ResourceRequest::McpReconnect("web".into()),
                |method, params| match method {
                    "config/read" => Ok(
                        json!({"config":{"mcp_servers":{"web":{"url":"https://host/mcp"}}},"layers":[]}),
                    ),
                    "mcpServerStatus/list" => Ok(
                        json!({"data":[{"name":"web","runtimeStatus":"authenticationRequired","authStatus":"notLoggedIn","tools":{}}],"nextCursor":null}),
                    ),
                    "mcpServer/oauth/login" => {
                        assert_eq!(params, json!({"name":"web","threadId":"owned-thread"}));
                        oauth = true;
                        Ok(
                            json!({"authorizationUrl":"https://oauth.example/authorize?state=fixture"}),
                        )
                    }
                    _ => panic!("unexpected {method}"),
                },
            );
            if thread.is_none() {
                assert_eq!(result.unwrap_err().code, ErrorCode::RuntimeUnavailable);
                assert!(!oauth);
            } else {
                assert_eq!(
                    result.unwrap()["authorizationUrl"],
                    "https://oauth.example/authorize?state=fixture"
                );
                assert!(oauth);
            }
        }
    }
    #[test]
    fn detach_only_updates_the_owning_project_layer_with_version_check() {
        let mut wrote = false;
        resource_with("/project",Some("thread"),ResourceRequest::McpDetach("project".into()),|method,params|match method {
            "config/read" => Ok(json!({"config":{"mcp_servers":{"shared":{"command":"global"},"project":{"command":"local"}}},"layers":[
                {"name":{"type":"user","file":"/account/config.toml"},"version":"user-v1","disabledReason":null,"config":{"mcp_servers":{"shared":{"command":"global"}}}},
                {"name":{"type":"project","dotCodexFolder":"/project/.codex"},"version":"project-v1","disabledReason":null,"config":{"mcp_servers":{"project":{"command":"local"}}}}]})),
            "config/value/write" => { assert_eq!(params["filePath"],"/project/.codex/config.toml"); assert_eq!(params["expectedVersion"],"project-v1"); assert_eq!(params["value"],json!({})); wrote=true; Ok(json!({})) },
            "config/mcpServer/reload" => Ok(json!({})), _ => panic!("unexpected {method}"),
        }).unwrap();
        assert!(wrote);
    }
    #[test]
    fn native_peer_preserves_account_cwd_and_proves_mutations_and_skill_inputs() {
        let root =
            std::env::temp_dir().join(format!("codex-resource-peer-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("project");
        let home = root.join("isolated-account");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("resource-config.json"),
            json!({"mcp_servers":{"owned":{"command":"tool"}},"skillEnabled":false}).to_string(),
        )
        .unwrap();
        let mut ctx = super::super::integration_tests::context(1, None);
        // Keep a valid but non-normalized path: the peer may report the same
        // working directory with a different spelling on Windows.
        ctx.cwd = cwd
            .join("..")
            .join("project")
            .to_string_lossy()
            .into_owned();
        let home = home.canonicalize().unwrap();
        ctx.execution.environment =
            vec![("CODEX_HOME".into(), home.to_string_lossy().into_owned())];
        let fixture = format!(
            "{}/src/session/adapter/codex/native/fixtures/resource-server.cjs",
            env!("CARGO_MANIFEST_DIR")
        );
        let connection = Transport::spawn_program(
            "node",
            &[fixture],
            &ctx.cwd,
            &ctx.execution.environment,
            Arc::new(|_| {}),
        )
        .unwrap();
        connection
            .call(Transport::deadline(), |id| {
                Ok(protocol::initialize(id, "fixture"))
            })
            .unwrap();
        connection.write(&json!({"method":"initialized"})).unwrap();
        assert_eq!(
            dispatch(&connection, &ctx, None, ResourceRequest::McpList).unwrap()[0]["status"],
            "approved"
        );
        assert_eq!(
            dispatch(
                &connection,
                &ctx,
                Some("owned-thread"),
                ResourceRequest::McpList
            )
            .unwrap()[0]["status"],
            "connected"
        );
        dispatch(
            &connection,
            &ctx,
            Some("owned-thread"),
            ResourceRequest::McpAttach(
                json!({"name":"added","command":"tool 'argument with spaces'"}),
            ),
        )
        .unwrap();
        let config: Value =
            serde_json::from_slice(&std::fs::read(home.join("resource-config.json")).unwrap())
                .unwrap();
        assert_eq!(
            config["mcp_servers"]["added"]["args"],
            json!(["argument with spaces"])
        );
        dispatch(
            &connection,
            &ctx,
            None,
            ResourceRequest::McpDetach("owned".into()),
        )
        .unwrap();
        dispatch(
            &connection,
            &ctx,
            None,
            ResourceRequest::SkillEnable("demo".into()),
        )
        .unwrap();
        let inputs = skill_inputs(&connection, &ctx, "$demo explain this").unwrap();
        assert_eq!(inputs,json!([{"type":"skill","name":"demo","path":format!("{}/skills/demo/SKILL.md",home.display())}]).as_array().unwrap().clone());
        connection.close();
        let config: Value =
            serde_json::from_slice(&std::fs::read(home.join("resource-config.json")).unwrap())
                .unwrap();
        assert!(config["mcp_servers"].get("owned").is_none());
        assert_eq!(config["skillEnabled"], true);
        let calls = std::fs::read_to_string(home.join("resource-calls.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            calls
                .iter()
                .filter(|c| c["method"] == "config/mcpServer/reload")
                .count(),
            2
        );
        assert!(calls
            .iter()
            .all(|c| !c["method"].as_str().unwrap().starts_with("thread/")));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn mcp_discovery_pages_native_status_and_never_invents_connection() {
        let mut calls = Vec::new();
        let result = resource_with("/project", Some("owned-thread"), ResourceRequest::McpList, |method, params| {
            calls.push((method.to_string(), params.clone()));
            match method {
                "config/read" => Ok(json!({"config":{"mcp_servers":{"shared":{"command":"tool"}}},"layers":[]})),
                "mcpServerStatus/list" if params["cursor"].is_null() => Ok(json!({"data":[{"name":"shared","runtimeStatus":"connected","tools":{"one":{}},"toolsError":null}],"nextCursor":"second"})),
                "mcpServerStatus/list" => Ok(json!({"data":[{"name":"plugin","runtimeStatus":null,"tools":{}}],"nextCursor":null})),
                _ => panic!("unexpected request {method}"),
            }
        }).unwrap();
        assert_eq!(result[0]["status"], "connected");
        assert_eq!(result[0]["toolCount"], 1);
        assert_eq!(result[1]["status"], "approved");
        let status = calls
            .iter()
            .filter(|(method, _)| method == "mcpServerStatus/list")
            .collect::<Vec<_>>();
        assert_eq!(status.len(), 2);
        assert_eq!(status[1].1["cursor"], "second");
        assert!(status
            .iter()
            .all(|(_, params)| params["threadId"] == "owned-thread"));
    }
    #[test]
    fn skills_keep_native_metadata_and_enable_using_the_exact_path() {
        let mut wrote = false;
        let result = resource_with("/project", None, ResourceRequest::SkillEnable("demo".into()), |method, params| {
            match method {
                "skills/list" => { assert_eq!(params["cwds"], json!(["/project"])); Ok(json!({"data":[{"cwd":"/project","skills":[{"name":"demo","description":"native","path":"/native/SKILL.md","scope":"repo","enabled":false,"pluginId":"plug"}],"errors":[]}]})) },
                "skills/config/write" => { assert_eq!(params, json!({"path":"/native/SKILL.md","enabled":true})); wrote = true; Ok(json!({})) },
                _ => panic!("unexpected {method}"),
            }
        }).unwrap();
        assert!(result.is_null());
        assert!(wrote);
        let info = skill_info(&json!({"name":"demo","description":"native","path":"/native/SKILL.md","scope":"repo","enabled":true,"pluginId":"plug"})).unwrap();
        assert_eq!(info["sourcePath"], "/native/SKILL.md");
        assert_eq!(info["invocation"], "$demo");
        assert_eq!(info["pluginId"], "plug");
        assert_eq!(info["installed"], true);
    }
    #[test]
    fn attach_writes_native_http_headers_and_reloads_real_connections() {
        let mut wrote = false;
        let mut reloaded = false;
        resource_with("/project", None, ResourceRequest::McpAttach(json!({"name":"web","transport":"http","url":"https://host/mcp","secretParams":{"Authorization":"secret"}})), |method, params| {
            match method {
                "config/read" => Ok(json!({"config":{"mcp_servers":{}},"layers":[]})),
                "config/value/write" => { assert_eq!(params["keyPath"], "mcp_servers"); assert_eq!(params["value"]["web"]["http_headers"]["Authorization"], "secret"); assert!(params["value"]["web"].get("headers").is_none()); wrote=true; Ok(json!({})) },
                "config/mcpServer/reload" => { reloaded=true; Ok(json!({})) },
                _ => panic!("unexpected {method}"),
            }
        }).unwrap();
        assert!(wrote && reloaded);
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[test]
    fn disabled_inherited_server_is_reenabled_with_owning_version() {
        let mut wrote = false;
        resource_with("/project",Some("thread"),ResourceRequest::McpReconnect("shared".into()),|method,params|match method {
            "config/read" => Ok(json!({"config":{"mcp_servers":{"shared":{"command":"demo","enabled":false}}},"layers":[{"name":{"type":"user","file":"/account/config.toml"},"version":"original","config":{"mcp_servers":{"shared":{"command":"demo","enabled":false}}}}]})),
            "config/value/write"=>{assert_eq!(params["filePath"],"/account/config.toml");assert_eq!(params["expectedVersion"],"original");assert_eq!(params["value"]["shared"]["enabled"],true);wrote=true;Ok(json!({}))},
            "config/mcpServer/reload"=>Ok(json!({})),
            "mcpServerStatus/list"=>Ok(json!({"data":[],"nextCursor":null})),
            _=>panic!("unexpected {method}"),
        }).unwrap();
        assert!(wrote);
    }
}
