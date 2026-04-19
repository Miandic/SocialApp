use aws_sdk_s3::Client as S3Client;
use aws_sdk_s3::primitives::ByteStream;
use uuid::Uuid;

use crate::config::Config;
use crate::errors::{AppError, AppResult};

pub struct MediaService;

impl MediaService {
    pub async fn create_s3_client(config: &Config) -> S3Client {
        let sdk_config = aws_config::from_env()
            .endpoint_url(&config.s3_endpoint)
            .region(aws_config::Region::new("us-east-1"))
            .credentials_provider(aws_sdk_s3::config::Credentials::new(
                &config.s3_access_key,
                &config.s3_secret_key,
                None,
                None,
                "env",
            ))
            .load()
            .await;

        aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::config::Builder::from(&sdk_config)
                .force_path_style(true) // Required for MinIO
                .build(),
        )
    }

    pub async fn upload(
        client: &S3Client,
        endpoint: &str,
        bucket: &str,
        content_type: &str,
        data: Vec<u8>,
    ) -> AppResult<(String, String)> {
        let extension = match content_type {
            "image/jpeg" => "jpg",
            "image/png" => "png",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "video/mp4" => "mp4",
            "video/webm" => "webm",
            "video/quicktime" => "mov",
            "application/pdf" => "pdf",
            "application/zip" => "zip",
            "application/x-zip-compressed" => "zip",
            "audio/mpeg" => "mp3",
            "audio/ogg" => "ogg",
            "text/plain" => "txt",
            _ => "bin",
        };

        let key = format!("uploads/{}.{}", Uuid::new_v4(), extension);

        client
            .put_object()
            .bucket(bucket)
            .key(&key)
            .body(ByteStream::from(data))
            .content_type(content_type)
            .send()
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("S3 upload failed: {e}")))?;

        let url = format!("{}/{}/{}", endpoint.trim_end_matches('/'), bucket, key);

        Ok((url, key))
    }

    pub async fn ensure_bucket(client: &S3Client, bucket: &str) {
        let exists = client.head_bucket().bucket(bucket).send().await.is_ok();
        if !exists {
            let _ = client.create_bucket().bucket(bucket).send().await;
            tracing::info!("Created S3 bucket: {bucket}");
        }

        // Allow public read so browsers can load media directly
        let policy = format!(
            r#"{{"Version":"2012-10-17","Statement":[{{"Effect":"Allow","Principal":"*","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::{}/*"]}}]}}"#,
            bucket
        );
        match client.put_bucket_policy().bucket(bucket).policy(policy).send().await {
            Ok(_)  => tracing::info!("Bucket '{bucket}' public-read policy set"),
            Err(e) => tracing::warn!("Could not set bucket policy for '{bucket}': {e}"),
        }
    }
}
