locals {
  # Demo-start control plane resources live in this file.
  # CloudFront route/origin wiring for /demo/start* and /demo/status* must stay in webapp_cdn.tf
  # because aws_cloudfront_distribution.webapp is defined there.
  demo_ecs_targets = [
    {
      region  = "us-east-2"
      cluster = module.ohio[0].ecs_cluster_name
      service = module.ohio[0].signaling_service_name
    },
    {
      region  = "us-west-1"
      cluster = module.north_california[0].ecs_cluster_name
      service = module.north_california[0].media_ingress_service_name
    },
    {
      region  = "us-west-1"
      cluster = module.north_california[0].ecs_cluster_name
      service = module.north_california[0].media_egress_service_name
    },
    {
      region  = "us-east-1"
      cluster = module.north_virginia[0].ecs_cluster_name
      service = module.north_virginia[0].media_ingress_service_name
    },
    {
      region  = "us-east-1"
      cluster = module.north_virginia[0].ecs_cluster_name
      service = module.north_virginia[0].media_egress_service_name
    },
  ]
}

data "archive_file" "demo_start" {
  type        = "zip"
  source_file = "${path.module}/lambda/demo_start.py"
  output_path = "${path.module}/.terraform/demo_start_lambda.zip"
}

data "archive_file" "demo_stop" {
  type        = "zip"
  source_file = "${path.module}/lambda/demo_stop.py"
  output_path = "${path.module}/.terraform/demo_stop_lambda.zip"
}

data "archive_file" "demo_status" {
  type        = "zip"
  source_file = "${path.module}/lambda/demo_status.py"
  output_path = "${path.module}/.terraform/demo_status_lambda.zip"
}

data "aws_iam_policy_document" "demo_lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "demo_start_lambda" {
  name               = "${var.stack_name}-demo-start-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.demo_lambda_assume_role.json
}

resource "aws_iam_role" "demo_stop_lambda" {
  name               = "${var.stack_name}-demo-stop-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.demo_lambda_assume_role.json
}

data "aws_iam_policy_document" "demo_scheduler_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "demo_scheduler_invoke_stop_lambda" {
  name               = "${var.stack_name}-demo-scheduler-invoke-stop-role"
  assume_role_policy = data.aws_iam_policy_document.demo_scheduler_assume_role.json
}

data "aws_iam_policy_document" "demo_scheduler_invoke_stop_lambda" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.demo_stop.arn]
  }
}

resource "aws_iam_role_policy" "demo_scheduler_invoke_stop_lambda" {
  name   = "${var.stack_name}-demo-scheduler-invoke-stop-lambda"
  role   = aws_iam_role.demo_scheduler_invoke_stop_lambda.id
  policy = data.aws_iam_policy_document.demo_scheduler_invoke_stop_lambda.json
}

data "aws_iam_policy_document" "demo_start_lambda" {
  statement {
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }

  statement {
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = ["*"]
  }

  statement {
    actions = [
      "scheduler:CreateSchedule",
      "scheduler:UpdateSchedule",
    ]
    resources = ["*"]
  }

  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.demo_scheduler_invoke_stop_lambda.arn]
  }
}

resource "aws_iam_role_policy" "demo_start_lambda" {
  name   = "${var.stack_name}-demo-start-lambda-policy"
  role   = aws_iam_role.demo_start_lambda.id
  policy = data.aws_iam_policy_document.demo_start_lambda.json
}

data "aws_iam_policy_document" "demo_stop_lambda" {
  statement {
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }

  statement {
    actions   = ["ecs:UpdateService"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "demo_stop_lambda" {
  name   = "${var.stack_name}-demo-stop-lambda-policy"
  role   = aws_iam_role.demo_stop_lambda.id
  policy = data.aws_iam_policy_document.demo_stop_lambda.json
}

resource "aws_lambda_function" "demo_stop" {
  function_name    = "${var.stack_name}-demo-stop"
  role             = aws_iam_role.demo_stop_lambda.arn
  filename         = data.archive_file.demo_stop.output_path
  source_code_hash = data.archive_file.demo_stop.output_base64sha256
  handler          = "demo_stop.handler"
  runtime          = "python3.12"
  timeout          = 30

  environment {
    variables = {
      TARGETS_JSON = jsonencode(local.demo_ecs_targets)
    }
  }
}

resource "aws_lambda_function" "demo_start" {
  function_name    = "${var.stack_name}-demo-start"
  role             = aws_iam_role.demo_start_lambda.arn
  filename         = data.archive_file.demo_start.output_path
  source_code_hash = data.archive_file.demo_start.output_base64sha256
  handler          = "demo_start.handler"
  runtime          = "python3.12"
  timeout          = 30

  environment {
    variables = {
      TARGETS_JSON = jsonencode(local.demo_ecs_targets)
    }
  }
}

resource "aws_lambda_function" "demo_status" {
  function_name    = "${var.stack_name}-demo-status"
  role             = aws_iam_role.demo_start_lambda.arn
  filename         = data.archive_file.demo_status.output_path
  source_code_hash = data.archive_file.demo_status.output_base64sha256
  handler          = "demo_status.handler"
  runtime          = "python3.12"
  timeout          = 30

  environment {
    variables = {
      TARGETS_JSON             = jsonencode(local.demo_ecs_targets)
      STOP_FUNCTION_ARN        = aws_lambda_function.demo_stop.arn
      SCHEDULER_ROLE_ARN       = aws_iam_role.demo_scheduler_invoke_stop_lambda.arn
      DEMO_SERVER_WARM_MINUTES = tostring(var.demo_server_warm_minutes)
      DEMO_STOP_SCHEDULE_NAME  = "${var.stack_name}-demo-stop"
    }
  }
}

resource "aws_apigatewayv2_api" "demo_control" {
  name          = "${var.stack_name}-demo-control"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "demo_start" {
  api_id                 = aws_apigatewayv2_api.demo_control.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.demo_start.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "demo_start" {
  api_id    = aws_apigatewayv2_api.demo_control.id
  route_key = "POST /demo/start"
  target    = "integrations/${aws_apigatewayv2_integration.demo_start.id}"
}

resource "aws_apigatewayv2_integration" "demo_status" {
  api_id                 = aws_apigatewayv2_api.demo_control.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.demo_status.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "demo_status" {
  api_id    = aws_apigatewayv2_api.demo_control.id
  route_key = "GET /demo/status"
  target    = "integrations/${aws_apigatewayv2_integration.demo_status.id}"
}

resource "aws_apigatewayv2_stage" "demo_control_default" {
  api_id      = aws_apigatewayv2_api.demo_control.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "allow_demo_api_gateway" {
  statement_id  = "AllowExecutionFromDemoApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.demo_start.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.demo_control.execution_arn}/*/*"
}

resource "aws_lambda_permission" "allow_demo_status_api_gateway" {
  statement_id  = "AllowExecutionFromDemoStatusApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.demo_status.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.demo_control.execution_arn}/*/*"
}
