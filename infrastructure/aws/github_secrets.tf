provider "github" {
  owner = var.github_owner
}

resource "github_actions_secret" "webapp_assets_bucket" {
  count = var.manage_github_actions_secrets ? 1 : 0

  repository      = var.github_repository_name
  secret_name     = "AWS_WEBAPP_ASSETS_BUCKET"
  plaintext_value = aws_s3_bucket.webapp_assets.bucket
}

resource "github_actions_secret" "webapp_cdn_distribution_id" {
  count = var.manage_github_actions_secrets ? 1 : 0

  repository      = var.github_repository_name
  secret_name     = "AWS_WEBAPP_CDN_DISTRIBUTION_ID"
  plaintext_value = aws_cloudfront_distribution.webapp.id
}

resource "github_actions_secret" "ecr_signaling_repository" {
  count = var.manage_github_actions_secrets ? 1 : 0

  repository      = var.github_repository_name
  secret_name     = "AWS_ECR_SIGNALING_REPOSITORY"
  plaintext_value = aws_ecr_repository.repos["signaling"].repository_url
}

resource "github_actions_secret" "ecr_media_repository" {
  count = var.manage_github_actions_secrets ? 1 : 0

  repository      = var.github_repository_name
  secret_name     = "AWS_ECR_MEDIA_REPOSITORY"
  plaintext_value = aws_ecr_repository.repos["media"].repository_url
}
