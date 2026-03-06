data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host_header" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "random_uuid" "webapp_assets_bucket_suffix" {}

resource "aws_s3_bucket" "webapp_assets" {
  bucket = "${var.stack_name}-webapp-${random_uuid.webapp_assets_bucket_suffix.result}"

  force_destroy = var.webapp_assets_force_destroy
}

resource "aws_s3_bucket_server_side_encryption_configuration" "webapp_assets" {
  bucket = aws_s3_bucket.webapp_assets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "webapp_assets" {
  name                              = "${var.stack_name}-webapp-assets-oac"
  description                       = "CloudFront access control for SignalSalad webapp assets bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "webapp" {
  enabled             = true
  comment             = "${var.stack_name} webapp static CDN"
  default_root_object = "index.html"
  price_class         = var.webapp_cdn_price_class

  origin {
    domain_name              = aws_s3_bucket.webapp_assets.bucket_regional_domain_name
    origin_id                = "webapp-assets-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.webapp_assets.id
  }

  origin {
    domain_name = module.ohio[0].signaling_public_dns
    origin_id   = "signaling-http-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    domain_name = replace(aws_apigatewayv2_api.demo_control.api_endpoint, "https://", "")
    origin_id   = "demo-control-api-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "webapp-assets-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
  }

  ordered_cache_behavior {
    path_pattern             = "/signaling*"
    target_origin_id         = "signaling-http-origin"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
  }

  ordered_cache_behavior {
    path_pattern             = "/status*"
    target_origin_id         = "signaling-http-origin"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
  }

  dynamic "ordered_cache_behavior" {
    # /demo/start* behavior is defined here because this file owns the
    # aws_cloudfront_distribution.webapp resource.
    # The API/Lambda scheduler resources that back this path are in demo-start.tf.
    for_each = [1]

    content {
      path_pattern             = "/demo/start*"
      target_origin_id         = "demo-control-api-origin"
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD", "OPTIONS"]
      compress                 = false
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = [1]

    content {
      path_pattern             = "/demo/status*"
      target_origin_id         = "demo-control-api-origin"
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = ["GET", "HEAD", "OPTIONS"]
      cached_methods           = ["GET", "HEAD", "OPTIONS"]
      compress                 = false
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
    }
  }

  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "webapp_assets_bucket_policy" {
  statement {
    sid = "AllowCloudFrontReadAccess"
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.webapp_assets.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.webapp.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "webapp_assets" {
  bucket = aws_s3_bucket.webapp_assets.id
  policy = data.aws_iam_policy_document.webapp_assets_bucket_policy.json
}
