use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct UploadResponse {
    pub url: String,
    pub key: String,
}
