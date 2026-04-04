#[cfg(target_arch = "wasm32")]
fn main() {
    eprintln!("six-tac bot service is only available on native targets");
    std::process::exit(1);
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use hex_tic_tac_engine::Game;
    use serde::{Deserialize, Serialize};
    use six_tac_bots::{choose_move_cached, is_bot_available, BotName};
    use std::str::FromStr;
    use tiny_http::{Header, Method, Response, Server, StatusCode};

    #[derive(Serialize)]
    struct BotListEntry {
        name: BotName,
        version: String,
        available: bool,
    }

    #[derive(Serialize)]
    struct BotListResponse {
        bots: Vec<BotListEntry>,
    }

    #[derive(Deserialize)]
    struct MoveRequest {
        bot_name: String,
        game_json: String,
        cache_key: Option<String>,
    }

    #[derive(Serialize)]
    struct MoveResponse {
        stones: [hex_tic_tac_engine::Cube; 2],
    }

    pub fn main() {
        if let Err(error) = run() {
            eprintln!("error: {error}");
            std::process::exit(1);
        }
    }

    fn run() -> Result<(), String> {
        let address = std::env::var("BOT_SERVICE_ADDR").unwrap_or_else(|_| "127.0.0.1:8788".to_string());
        let server = Server::http(&address).map_err(|error| error.to_string())?;
        eprintln!("six-tac bot service listening on http://{address}");
        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            let response = match (method, url.as_str()) {
                (Method::Get, "/v1/bots") => json_response(&BotListResponse {
                    bots: BotName::ALL
                        .iter()
                        .copied()
                        .map(|bot_name| BotListEntry {
                            name: bot_name,
                            version: if bot_name == BotName::Kraken {
                                std::env::var("KRAKEN_MODEL_VERSION").unwrap_or_else(|_| "kraken_v1".to_string())
                            } else {
                                "builtin".to_string()
                            },
                            available: is_bot_available(bot_name),
                        })
                        .collect(),
                }),
                (Method::Get, "/health") => text_response(StatusCode(200), "ok"),
                (Method::Post, "/v1/best-move") => handle_best_move(&mut request),
                _ => text_response(StatusCode(404), "not found"),
            };
            let _ = request.respond(response);
        }
        Ok(())
    }

    fn is_timeout_error(error: &str) -> bool {
        let normalized = error.to_ascii_lowercase();
        normalized.contains("timed out") || normalized.contains("timeout")
    }

    fn handle_best_move(request: &mut tiny_http::Request) -> Response<std::io::Cursor<Vec<u8>>> {
        let result = (|| -> Result<MoveResponse, String> {
            let mut body = String::new();
            request
                .as_reader()
                .read_to_string(&mut body)
                .map_err(|error| error.to_string())?;
            let payload = serde_json::from_str::<MoveRequest>(&body).map_err(|error| error.to_string())?;
            let bot_name = BotName::from_str(&payload.bot_name)?;
            let game = if payload.game_json.trim().is_empty() {
                Game::new()
            } else {
                Game::from_json_str(&payload.game_json).map_err(|error| error.to_string())?
            };
            Ok(MoveResponse {
                stones: choose_move_cached(bot_name, &game, payload.cache_key.as_deref())?,
            })
        })();

        match result {
            Ok(payload) => json_response(&payload),
            Err(error) => json_error(
                if is_timeout_error(&error) { StatusCode(504) } else { StatusCode(400) },
                &error,
            ),
        }
    }

    fn json_response<T: Serialize>(value: &T) -> Response<std::io::Cursor<Vec<u8>>> {
        let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{\"error\":\"serialization failed\"}".to_vec());
        let mut response = Response::from_data(body).with_status_code(StatusCode(200));
        response.add_header(json_header());
        response
    }

    fn json_error(status: StatusCode, message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
        let body = serde_json::to_vec(&serde_json::json!({ "error": message }))
            .unwrap_or_else(|_| b"{\"error\":\"serialization failed\"}".to_vec());
        let mut response = Response::from_data(body).with_status_code(status);
        response.add_header(json_header());
        response
    }

    fn text_response(status: StatusCode, message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
        let mut response = Response::from_string(message.to_string()).with_status_code(status);
        response.add_header(
            Header::from_bytes(&b"Content-Type"[..], &b"text/plain; charset=utf-8"[..])
                .expect("valid text header"),
        );
        response
    }

    fn json_header() -> Header {
        Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..])
            .expect("valid json header")
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    native::main();
}
