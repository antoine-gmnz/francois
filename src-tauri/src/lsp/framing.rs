// lsp/framing.rs — code-editor-lsp FR-1: the JSON-RPC base protocol's
// `Content-Length` framing over any `BufRead` / `Write`.
//
// A frame is a header block (`Name: value` lines, each ended by `\r\n`, the
// block ended by an empty line) followed by exactly `Content-Length` bytes of
// body. Header names compare case-insensitively; bare `\n` line ends are
// tolerated; `Content-Type` and any unknown header are ignored. Lines that are
// not headers BEFORE the first header of a frame are skipped rather than fatal:
// a server that leaks one stray `console.log` onto stdout should not lose its
// whole session over it.

use std::io::{self, BufRead, Write};

/// A body larger than this is refused — a corrupt length must not make the
/// reader allocate gigabytes. Generous: a workspace/symbol answer on a big
/// monorepo is a few MiB.
pub(crate) const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Read one frame's body. `Ok(None)` on a clean EOF between frames; an error on
/// EOF inside a frame, a missing/invalid `Content-Length`, or an oversized body.
pub(crate) fn read_message<R: BufRead>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut length: Option<usize> = None;
    let mut saw_header = false;
    let mut line = Vec::new();
    loop {
        line.clear();
        if r.read_until(b'\n', &mut line)? == 0 {
            return if saw_header {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "eof inside a header block",
                ))
            } else {
                Ok(None)
            };
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            if saw_header {
                break;
            }
            continue;
        }
        let Some((name, value)) = text.split_once(':') else {
            if saw_header {
                return Err(bad("malformed header line"));
            }
            continue; // leading noise, see the module note
        };
        saw_header = true;
        if name.trim().eq_ignore_ascii_case("content-length") {
            length = Some(
                value
                    .trim()
                    .parse()
                    .map_err(|_| bad("invalid Content-Length"))?,
            );
        }
    }
    let Some(len) = length else {
        return Err(bad("frame without Content-Length"));
    };
    if len > MAX_BODY_BYTES {
        return Err(bad("frame body exceeds the size cap"));
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Write one frame and flush it — a buffered frame is a request the server
/// never sees.
pub(crate) fn write_message<W: Write>(w: &mut W, body: &[u8]) -> io::Result<()> {
    write!(w, "Content-Length: {}\r\n\r\n", body.len())?;
    w.write_all(body)?;
    w.flush()
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Read};

    /// A reader that hands out at most `step` bytes per `read` — partial reads.
    struct Trickle {
        data: Vec<u8>,
        pos: usize,
        step: usize,
    }
    impl Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.step.min(buf.len()).min(self.data.len() - self.pos);
            buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    fn trickle(data: &[u8], step: usize) -> BufReader<Trickle> {
        BufReader::with_capacity(
            step.max(1),
            Trickle {
                data: data.to_vec(),
                pos: 0,
                step,
            },
        )
    }

    #[test]
    fn round_trips_a_frame() {
        let mut out = Vec::new();
        write_message(&mut out, br#"{"jsonrpc":"2.0"}"#).unwrap();
        assert_eq!(
            out,
            b"Content-Length: 17\r\n\r\n{\"jsonrpc\":\"2.0\"}".to_vec()
        );
        let mut r = &out[..];
        assert_eq!(
            read_message(&mut r).unwrap().unwrap(),
            br#"{"jsonrpc":"2.0"}"#.to_vec()
        );
        assert_eq!(read_message(&mut r).unwrap(), None);
    }

    #[test]
    fn reads_byte_by_byte_partial_reads() {
        let mut data = Vec::new();
        write_message(&mut data, "{\"a\":\"é\"}".as_bytes()).unwrap();
        write_message(&mut data, b"{}").unwrap();
        let mut r = trickle(&data, 1);
        assert_eq!(
            read_message(&mut r).unwrap().unwrap(),
            "{\"a\":\"é\"}".as_bytes()
        );
        assert_eq!(read_message(&mut r).unwrap().unwrap(), b"{}");
        assert_eq!(read_message(&mut r).unwrap(), None);
    }

    #[test]
    fn reads_several_messages_from_one_chunk() {
        let data =
            b"Content-Length: 2\r\n\r\n{}Content-Length: 4\r\n\r\nnullContent-Length: 1\r\n\r\n1";
        let mut r = trickle(data, data.len());
        let mut got = Vec::new();
        while let Some(m) = read_message(&mut r).unwrap() {
            got.push(String::from_utf8(m).unwrap());
        }
        assert_eq!(got, vec!["{}", "null", "1"]);
    }

    #[test]
    fn header_names_are_case_insensitive_and_other_headers_ignored() {
        let data = b"content-type: application/vscode-jsonrpc; charset=utf-8\r\nCONTENT-LENGTH:  2 \r\n\r\n{}";
        let mut r = &data[..];
        assert_eq!(read_message(&mut r).unwrap().unwrap(), b"{}");
    }

    #[test]
    fn bare_newlines_and_leading_noise_are_tolerated() {
        let data = b"\nrunning 1 test\nContent-Length: 2\n\n{}";
        let mut r = &data[..];
        assert_eq!(read_message(&mut r).unwrap().unwrap(), b"{}");
    }

    #[test]
    fn missing_or_bad_length_and_truncation_are_errors() {
        let mut r = &b"X-Other: 1\r\n\r\n{}"[..];
        assert!(read_message(&mut r).is_err());
        let mut r = &b"Content-Length: nope\r\n\r\n"[..];
        assert!(read_message(&mut r).is_err());
        let mut r = &b"Content-Length: 10\r\n\r\n{}"[..];
        assert!(read_message(&mut r).is_err());
        let mut r = &b"Content-Length: 2\r\n"[..];
        assert!(read_message(&mut r).is_err());
        let huge = format!("Content-Length: {}\r\n\r\n", MAX_BODY_BYTES + 1);
        let mut r = huge.as_bytes();
        assert!(read_message(&mut r).is_err());
    }
}
