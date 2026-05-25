resource "aws_iam_role" "demo_bot_worker_lambda" {
  count = var.enable_demo_bot_worker ? 1 : 0

  name               = "${var.stack_name}-demo-bot-worker-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.demo_lambda_assume_role.json
}

data "aws_iam_policy_document" "demo_bot_worker_lambda" {
  statement {
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "demo_bot_worker_lambda" {
  count = var.enable_demo_bot_worker ? 1 : 0

  name   = "${var.stack_name}-demo-bot-worker-lambda-policy"
  role   = aws_iam_role.demo_bot_worker_lambda[0].id
  policy = data.aws_iam_policy_document.demo_bot_worker_lambda.json
}

resource "aws_lambda_function" "demo_bot_worker" {
  count = var.enable_demo_bot_worker ? 1 : 0

  function_name = local.demo_bot_worker_function_name
  role          = aws_iam_role.demo_bot_worker_lambda[0].arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.repos["bot-worker"].repository_url}:${var.demo_bot_worker_image_tag}"
  timeout       = var.demo_bot_worker_timeout_seconds
  memory_size   = var.demo_bot_worker_memory_mb

  ephemeral_storage {
    size = var.demo_bot_worker_ephemeral_storage_mb
  }

  environment {
    variables = {
      BOT_LOG_DIR                      = "/tmp/bot-logs"
      BOT_ROOM_EGRESS_READY_TIMEOUT_MS = tostring(var.demo_bot_room_egress_ready_timeout_ms)
      BOT_MEDIA_ENABLE_TIMEOUT_MS      = tostring(var.demo_bot_media_enable_timeout_ms)
      BOT_START_STAGGER_MS             = "0"
      BOT_START_STAGGER_RESET_MS       = "120000"
      BOT_START_DELAY_MS               = "0"
      PUPPETEER_LAUNCH_TIMEOUT_MS      = "60000"
      PUPPETEER_EXECUTABLE_PATH        = "/usr/lib/chromium/chromium"
      PUPPETEER_DUMPIO                 = "1"
      PUPPETEER_CHROMIUM_STDERR        = "1"
    }
  }

  depends_on = [aws_iam_role_policy.demo_bot_worker_lambda]
}

resource "aws_lambda_function_event_invoke_config" "demo_bot_worker" {
  count = var.enable_demo_bot_worker ? 1 : 0

  function_name                = aws_lambda_function.demo_bot_worker[0].function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}
