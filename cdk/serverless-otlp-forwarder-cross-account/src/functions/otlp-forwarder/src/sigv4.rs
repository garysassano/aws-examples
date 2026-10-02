use std::str::FromStr;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use async_trait::async_trait;
use aws_credential_types::provider::{ProvideCredentials, SharedCredentialsProvider};
use aws_sigv4::http_request::{SignableBody, SignableRequest, SigningSettings, sign};
use aws_sigv4::sign::v4;
use bytes::Bytes;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serverless_otlp_forwarder_core::InstrumentedHttpClient;
use serverless_otlp_forwarder_core::http_sender::{HttpForwarderResponse, HttpOtlpForwarderClient};
use url::Url;

/// Signs each OTLP request with SigV4, as the CloudWatch OTLP endpoint requires, then
/// sends it with the instrumented client.
pub struct SigV4HttpClient {
    inner: InstrumentedHttpClient,
    credentials: SharedCredentialsProvider,
    region: String,
    service: String,
}

impl SigV4HttpClient {
    pub fn new(
        inner: InstrumentedHttpClient,
        credentials: SharedCredentialsProvider,
        region: String,
        service: String,
    ) -> Self {
        Self {
            inner,
            credentials,
            region,
            service,
        }
    }

    async fn sign(&self, url: &Url, headers: &mut HeaderMap, payload: &[u8]) -> Result<()> {
        let identity = self
            .credentials
            .provide_credentials()
            .await
            .context("Failed to load credentials for SigV4 signing")?
            .into();
        let params = v4::SigningParams::builder()
            .identity(&identity)
            .region(&self.region)
            .name(&self.service)
            .time(SystemTime::now())
            .settings(SigningSettings::default())
            .build()
            .context("Failed to build SigV4 signing parameters")?
            .into();

        let header_pairs = headers
            .iter()
            .map(|(name, value)| Ok((name.as_str(), value.to_str()?)))
            .collect::<Result<Vec<_>>>()?;
        let request = SignableRequest::new(
            "POST",
            url.as_str(),
            header_pairs.into_iter(),
            SignableBody::Bytes(payload),
        )
        .context("Failed to build signable request")?;

        let (instructions, _signature) = sign(request, &params)
            .context("Failed to sign OTLP request")?
            .into_parts();
        for (name, value) in instructions.headers() {
            headers.insert(HeaderName::from_str(name)?, HeaderValue::from_str(value)?);
        }
        Ok(())
    }
}

#[async_trait]
impl HttpOtlpForwarderClient for SigV4HttpClient {
    async fn post_telemetry(
        &self,
        target_url: Url,
        mut headers: HeaderMap,
        payload: Bytes,
        timeout: Duration,
    ) -> Result<HttpForwarderResponse> {
        self.sign(&target_url, &mut headers, &payload).await?;
        self.inner
            .post_telemetry(target_url, headers, payload, timeout)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_credential_types::Credentials;
    use reqwest_middleware::ClientBuilder;

    #[tokio::test]
    async fn test_sign_adds_sigv4_headers() {
        let client = SigV4HttpClient::new(
            InstrumentedHttpClient::new(ClientBuilder::new(reqwest::Client::new()).build()),
            SharedCredentialsProvider::new(Credentials::for_tests()),
            "eu-central-1".to_string(),
            "xray".to_string(),
        );
        let url = Url::parse("https://xray.eu-central-1.amazonaws.com/v1/traces").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            HeaderValue::from_static("application/x-protobuf"),
        );

        client.sign(&url, &mut headers, b"payload").await.unwrap();

        let authorization = headers["authorization"].to_str().unwrap();
        assert!(authorization.starts_with("AWS4-HMAC-SHA256 Credential="));
        assert!(authorization.contains("/eu-central-1/xray/aws4_request"));
        assert!(headers.contains_key("x-amz-date"));
    }
}
