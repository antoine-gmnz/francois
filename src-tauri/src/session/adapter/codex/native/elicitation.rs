//! MCP forms keep schema values in the adapter and emit only normalized questions.
use super::requests::{
    NativeScope, Question, QuestionOption, RequestContext, RequestError, RequestKind, UserInput,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Form {
    pub input: UserInput,
    schema: Value,
}
#[derive(Clone, Debug, PartialEq)]
pub(super) struct UrlRequest {
    pub context: RequestContext,
    pub server: String,
    pub message: String,
    pub url: String,
}
pub(super) fn parse(params: Value, scope: &NativeScope) -> Result<RequestKind, RequestError> {
    let thread = params["threadId"]
        .as_str()
        .ok_or(RequestError::InvalidParams)?;
    let turn = params["turnId"].as_str().unwrap_or(&scope.turn_id);
    if thread != scope.thread_id || turn != scope.turn_id {
        return Err(RequestError::StaleScope);
    }
    let server = params["serverName"]
        .as_str()
        .filter(|name| !name.is_empty())
        .ok_or(RequestError::InvalidParams)?;
    let context = RequestContext {
        thread_id: thread.into(),
        turn_id: turn.into(),
        item_id: format!("mcp:{server}"),
    };
    let message = params["message"].as_str().unwrap_or("MCP server request");
    match params["mode"].as_str() {
        Some("url") => {
            let url = params["url"].as_str().ok_or(RequestError::InvalidParams)?;
            let parsed = url::Url::parse(url).map_err(|_| RequestError::InvalidParams)?;
            if !matches!(parsed.scheme(), "https" | "http") || parsed.host_str().is_none() {
                return Err(RequestError::InvalidParams);
            }
            Ok(RequestKind::ElicitationUrl(UrlRequest {
                context,
                server: server.into(),
                message: message.into(),
                url: url.into(),
            }))
        }
        Some("form" | "openai/form" | "openaiForm") => {
            let schema = params["requestedSchema"].clone();
            if schema["type"] != "object" {
                return Err(RequestError::InvalidParams);
            }
            let properties = schema["properties"]
                .as_object()
                .filter(|p| !p.is_empty() && p.len() <= 32)
                .ok_or(RequestError::InvalidParams)?;
            let mut questions = vec![];
            for (name, field) in properties {
                if name.is_empty()
                    || !matches!(
                        field["type"].as_str(),
                        Some("string" | "integer" | "number" | "boolean" | "array" | "object")
                    )
                    || field.get("$ref").is_some()
                {
                    return Err(RequestError::InvalidParams);
                }
                let choices = options(field)?;
                let required = is_required(&schema, name);
                let mut prompt = format!(
                    "{message}\n{}",
                    field["description"].as_str().unwrap_or(name)
                );
                if matches!(field["type"].as_str(), Some("array" | "object")) {
                    prompt.push_str("\nEnter valid JSON.");
                }
                if !required {
                    prompt.push_str("\nOptional: enter __skip__ to omit this field.");
                }
                questions.push(Question {
                    id: name.clone(),
                    header: field["title"].as_str().unwrap_or(name).into(),
                    question: prompt,
                    is_other: choices.is_empty() || !required,
                    is_secret: contains_secret(field, 0),
                    options: (!choices.is_empty()).then_some(choices),
                });
            }
            Ok(RequestKind::Elicitation(Form {
                input: UserInput {
                    context,
                    questions,
                    is_blocking: true,
                },
                schema,
            }))
        }
        _ => Err(RequestError::UnsupportedMethod),
    }
}
fn contains_secret(schema: &Value, depth: u8) -> bool {
    if depth > 16 {
        return true;
    }
    schema["format"] == "password"
        || schema["writeOnly"] == true
        || match schema {
            Value::Object(fields) => fields
                .values()
                .any(|value| contains_secret(value, depth + 1)),
            Value::Array(fields) => fields.iter().any(|value| contains_secret(value, depth + 1)),
            _ => false,
        }
}
fn is_required(schema: &Value, name: &str) -> bool {
    schema["required"]
        .as_array()
        .is_some_and(|fields| fields.iter().any(|field| field == name))
}
fn options(schema: &Value) -> Result<Vec<QuestionOption>, RequestError> {
    let mut choices = vec![];
    if schema["type"] == "boolean" {
        for label in ["true", "false"] {
            choices.push(QuestionOption {
                label: label.into(),
                description: String::new(),
            });
        }
    }
    if let Some(values) = schema["enum"].as_array() {
        for (i, value) in values.iter().enumerate() {
            let label = value.as_str().ok_or(RequestError::InvalidParams)?;
            choices.push(QuestionOption {
                label: label.into(),
                description: schema["enumNames"][i].as_str().unwrap_or("").into(),
            });
        }
    }
    if let Some(values) = schema["oneOf"].as_array() {
        for value in values {
            choices.push(QuestionOption {
                label: value["const"]
                    .as_str()
                    .ok_or(RequestError::InvalidParams)?
                    .into(),
                description: value["title"].as_str().unwrap_or("").into(),
            });
        }
    }
    Ok(choices)
}
impl Form {
    pub(super) fn content(
        &self,
        answers: &BTreeMap<String, String>,
    ) -> Result<Value, RequestError> {
        let mut content = serde_json::Map::new();
        for (name, field) in self.schema["properties"]
            .as_object()
            .ok_or(RequestError::InvalidAnswer)?
        {
            let answer = answers.get(name).ok_or(RequestError::InvalidAnswer)?;
            if !is_required(&self.schema, name) && answer == "__skip__" {
                continue;
            }
            let value = if field["type"] == "string" {
                json!(answer)
            } else {
                serde_json::from_str(answer).map_err(|_| RequestError::InvalidAnswer)?
            };
            validate(field, &value, 0)?;
            content.insert(name.clone(), value);
        }
        Ok(Value::Object(content))
    }
}
fn validate(schema: &Value, value: &Value, depth: u8) -> Result<(), RequestError> {
    if depth > 16 {
        return Err(RequestError::InvalidAnswer);
    }
    let valid = match schema["type"].as_str() {
        Some("string") => value.as_str().is_some_and(|s| {
            let len = s.chars().count() as u64;
            schema["minLength"].as_u64().is_none_or(|min| len >= min)
                && schema["maxLength"].as_u64().is_none_or(|max| len <= max)
        }),
        Some("number" | "integer") => value.as_f64().is_some_and(|n| {
            n.is_finite()
                && (schema["type"] != "integer" || value.is_i64() || value.is_u64())
                && schema["minimum"].as_f64().is_none_or(|min| n >= min)
                && schema["maximum"].as_f64().is_none_or(|max| n <= max)
        }),
        Some("boolean") => value.is_boolean(),
        Some("array") => value.as_array().is_some_and(|values| {
            let len = values.len() as u64;
            schema["minItems"].as_u64().is_none_or(|min| len >= min)
                && schema["maxItems"].as_u64().is_none_or(|max| len <= max)
                && values
                    .iter()
                    .all(|item| validate(&schema["items"], item, depth + 1).is_ok())
        }),
        Some("object") => value.as_object().is_some_and(|object| {
            let properties = schema["properties"].as_object();
            schema["required"].as_array().is_none_or(|required| {
                required
                    .iter()
                    .all(|name| name.as_str().is_some_and(|name| object.contains_key(name)))
            }) && object.iter().all(|(name, value)| {
                properties
                    .and_then(|properties| properties.get(name))
                    .map_or(schema["additionalProperties"] != false, |field| {
                        validate(field, value, depth + 1).is_ok()
                    })
            })
        }),
        None => schema.get("enum").is_some() || schema.get("oneOf").is_some(),
        _ => false,
    };
    if !valid
        || schema["enum"]
            .as_array()
            .is_some_and(|values| !values.contains(value))
        || schema["oneOf"]
            .as_array()
            .is_some_and(|options| !options.iter().any(|option| option["const"] == *value))
    {
        return Err(RequestError::InvalidAnswer);
    }
    Ok(())
}
