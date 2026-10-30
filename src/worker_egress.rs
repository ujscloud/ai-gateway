//! Temporary, opt-in Worker egress observation. No provider traffic or credentials.
use futures_util::{
    future::{select, Either},
    StreamExt,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::{net::IpAddr, time::Duration};
use worker::*;

pub const PATH: &str = "/__diagnostics/egress";
const TARGET: &str = "https://api.ipify.org";
const MAX_BYTES: usize = 64;

fn authorized(secret: &str, header: Option<&str>) -> bool {
    // Fail closed on absent/short configuration. Use a separate random secret,
    // never a provider key. MAC verification avoids a prefix-dependent compare.
    let Some(candidate) = header.and_then(|h| h.strip_prefix("Bearer ")) else {
        return false;
    };
    if secret.len() < 32 || candidate.len() > 256 {
        return false;
    }
    let mut expected = Hmac::<Sha256>::new_from_slice(b"worker-egress-auth").unwrap();
    expected.update(secret.as_bytes());
    let mut actual = Hmac::<Sha256>::new_from_slice(b"worker-egress-auth").unwrap();
    actual.update(candidate.as_bytes());
    actual
        .verify_slice(&expected.finalize().into_bytes())
        .is_ok()
}

fn reply(status: u16, body: serde_json::Value) -> Result<Response> {
    let mut response = Response::from_json(&body)?.with_status(status);
    response.headers_mut().set("cache-control", "no-store")?;
    response
        .headers_mut()
        .set("x-content-type-options", "nosniff")?;
    Ok(response)
}

async fn observe(signal: &AbortSignal) -> Result<String> {
    // Construct from scratch. Never copy the incoming request, headers or body.
    // Reject redirects so even the fixed service cannot choose another target.
    let headers = Headers::new();
    headers.set("accept", "text/plain")?;
    headers.set("cache-control", "no-store")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Manual);
    let request = Request::new_with_init(TARGET, &init)?;
    let mut response = Fetch::Request(request).send_with_signal(signal).await?;
    if response.status_code() != 200 {
        return Err(Error::RustError("upstream".into()));
    }
    let mut stream = response.stream()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if chunk.len() > MAX_BYTES - bytes.len() {
            return Err(Error::RustError("upstream".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    let ip = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|text| text.trim().parse::<IpAddr>().ok())
        .ok_or_else(|| Error::RustError("upstream".into()))?;
    Ok(ip.to_string())
}

pub async fn handle(req: Request, env: Env) -> Result<Response> {
    let enabled = env
        .var("EGRESS_DIAGNOSTICS_ENABLED")
        .ok()
        .map(|v| v.to_string());
    let secret = env
        .secret("EGRESS_DIAGNOSTICS_SECRET")
        .ok()
        .map(|v| v.to_string());
    let auth = req.headers().get("authorization").ok().flatten();
    if enabled.as_deref() != Some("true")
        || !authorized(secret.as_deref().unwrap_or(""), auth.as_deref())
    {
        // Identical for disabled, unconfigured and invalid credentials.
        return reply(404, serde_json::json!({"error": "not_found"}));
    }
    if req.method() != Method::Get || req.url()?.query().is_some() {
        return reply(400, serde_json::json!({"error": "invalid_request"}));
    }
    let controller = AbortController::default();
    let signal = controller.signal();
    let operation = observe(&signal);
    futures_util::pin_mut!(operation);
    // One deadline includes both headers and the complete bounded body.
    let result = match select(operation, Delay::from(Duration::from_secs(3))).await {
        Either::Left((Ok(ip), _)) => reply(
            200,
            serde_json::json!({
                "ip": ip,
                "target": TARGET,
                "scope": "Only this target's observed egress; not evidence of OpenAI egress or region eligibility."
            }),
        ),
        Either::Left((Err(_), _)) => reply(502, serde_json::json!({"error": "diagnostic_failed"})),
        Either::Right(_) => reply(504, serde_json::json!({"error": "diagnostic_timeout"})),
    };
    // Cancel on errors, oversized bodies and timeout; no background probes.
    controller.abort();
    result
}
