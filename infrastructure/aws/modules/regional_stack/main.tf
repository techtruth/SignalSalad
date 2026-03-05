data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  az_names   = sort(data.aws_availability_zones.available.names)
  udp_from   = tonumber(split("-", var.media_udp_port_range)[0])
  udp_to     = tonumber(split("-", var.media_udp_port_range)[1])
  ingress_to = min(local.udp_from + 49, local.udp_to)
  egress_from = min(
    local.udp_from + 50,
    local.udp_to,
  )

  ingress_udp_ports = range(local.udp_from, local.ingress_to + 1)
  egress_udp_ports = local.egress_from <= local.udp_to ? range(
    local.egress_from,
    local.udp_to + 1,
  ) : []

  subnet_ids = sort([for subnet in aws_default_subnet.this : subnet.id])

  signaling_container_definitions = jsonencode([
    {
      name      = "signaling"
      image     = var.signaling_image
      essential = true
      command   = ["npm", "start"]
      environment = [
        { name = "SIGNALING_SECURE_WEBSOCKET", value = "true" },
        { name = "SIGNALING_WS_HTTP_PORT", value = "8080" },
        { name = "SIGNALING_WS_HTTPS_PORT", value = "8443" },
        { name = "SIGNALING_NETSOCKET_PORT", value = "1188" },
      ]
      portMappings = [
        { containerPort = 8080, hostPort = 8080, protocol = "tcp" },
        { containerPort = 8443, hostPort = 8443, protocol = "tcp" },
        { containerPort = 1188, hostPort = 1188, protocol = "tcp" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.signaling[0].name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  media_ingress_container_definitions = jsonencode([
    {
      name      = "media-ingress"
      image     = var.media_image
      essential = true
      command   = ["npm", "run", "ingress"]
      environment = [
        { name = "SIGNALING_HOST", value = var.signaling_host },
        { name = "SIGNALING_PORT", value = "1188" },
        { name = "REGION", value = var.region_key },
      ]
      portMappings = [
        for port in local.ingress_udp_ports : {
          containerPort = port
          hostPort      = port
          protocol      = "udp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.media[0].name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "ecs-ingress"
        }
      }
    }
  ])

  media_egress_container_definitions = jsonencode([
    {
      name      = "media-egress"
      image     = var.media_image
      essential = true
      command   = ["npm", "run", "egress"]
      environment = [
        { name = "SIGNALING_HOST", value = var.signaling_host },
        { name = "SIGNALING_PORT", value = "1188" },
        { name = "REGION", value = var.region_key },
      ]
      portMappings = [
        for port in local.egress_udp_ports : {
          containerPort = port
          hostPort      = port
          protocol      = "udp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.media[0].name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "ecs-egress"
        }
      }
    }
  ])
}

resource "aws_default_vpc" "this" {}

resource "aws_default_subnet" "this" {
  for_each = toset(local.az_names)

  availability_zone = each.value
}

resource "aws_security_group" "ecs" {
  name        = "${var.stack_name}-${var.region_label}-ecs-sg"
  description = "ECS task ingress for signaling/media"
  vpc_id      = aws_default_vpc.this.id

  tags = {
    Name = "${var.stack_name}-${var.region_label}-ecs-sg"
  }
}

resource "aws_security_group_rule" "signaling_http" {
  count = var.create_signaling ? 1 : 0

  type              = "ingress"
  from_port         = 8080
  to_port           = 8080
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.ecs.id
}

resource "aws_security_group_rule" "signaling_https" {
  count = var.create_signaling ? 1 : 0

  type              = "ingress"
  from_port         = 8443
  to_port           = 8443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.ecs.id
}

resource "aws_security_group_rule" "signaling_netsocket" {
  count = var.create_signaling ? 1 : 0

  type              = "ingress"
  from_port         = 1188
  to_port           = 1188
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.ecs.id
}

resource "aws_security_group_rule" "media_udp" {
  count = var.create_media ? 1 : 0

  type              = "ingress"
  from_port         = local.udp_from
  to_port           = local.udp_to
  protocol          = "udp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.ecs.id
}

resource "aws_security_group_rule" "egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.ecs.id
}

resource "aws_cloudwatch_log_group" "signaling" {
  count = var.create_signaling ? 1 : 0

  name              = "/ecs/${var.stack_name}/${var.region_label}/signaling"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "media" {
  count = var.create_media ? 1 : 0

  name              = "/ecs/${var.stack_name}/${var.region_label}/media"
  retention_in_days = 7
}

resource "aws_ecs_cluster" "this" {
  name = "${var.stack_name}-${var.region_label}"
}

data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "${var.stack_name}-${var.region_label}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_ecs_task_definition" "signaling" {
  count = var.create_signaling ? 1 : 0

  family                   = "${var.stack_name}-${var.region_label}-signaling"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.signaling_task_cpu)
  memory                   = tostring(var.signaling_task_memory)
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  container_definitions    = local.signaling_container_definitions
}

resource "aws_lb" "signaling" {
  count = var.create_signaling ? 1 : 0

  name               = substr("${var.stack_name}-${var.region_label}-nlb", 0, 32)
  internal           = false
  load_balancer_type = "network"
  subnets            = local.subnet_ids
}

resource "aws_lb_target_group" "signaling_http" {
  count = var.create_signaling ? 1 : 0

  name        = substr("${var.stack_name}-${var.region_label}-http", 0, 32)
  port        = 8080
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = aws_default_vpc.this.id

  health_check {
    protocol = "TCP"
    port     = "8080"
  }
}

resource "aws_lb_target_group" "signaling_netsocket" {
  count = var.create_signaling ? 1 : 0

  name        = substr("${var.stack_name}-${var.region_label}-ns", 0, 32)
  port        = 1188
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = aws_default_vpc.this.id

  health_check {
    protocol = "TCP"
    port     = "1188"
  }
}

resource "aws_lb_target_group" "signaling_https" {
  count = var.create_signaling ? 1 : 0

  name        = substr("${var.stack_name}-${var.region_label}-https", 0, 32)
  port        = 8443
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = aws_default_vpc.this.id

  health_check {
    protocol = "TCP"
    port     = "8443"
  }
}

resource "aws_lb_listener" "signaling_http" {
  count = var.create_signaling ? 1 : 0

  load_balancer_arn = aws_lb.signaling[0].arn
  port              = 80
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.signaling_http[0].arn
  }
}

resource "aws_lb_listener" "signaling_https" {
  count = var.create_signaling ? 1 : 0

  load_balancer_arn = aws_lb.signaling[0].arn
  port              = 443
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.signaling_https[0].arn
  }
}

resource "aws_lb_listener" "signaling_netsocket" {
  count = var.create_signaling ? 1 : 0

  load_balancer_arn = aws_lb.signaling[0].arn
  port              = 1188
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.signaling_netsocket[0].arn
  }
}

resource "aws_ecs_service" "signaling" {
  count = var.create_signaling ? 1 : 0

  name            = "${var.stack_name}-${var.region_label}-signaling"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.signaling[0].arn
  desired_count   = var.signaling_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.signaling_http[0].arn
    container_name   = "signaling"
    container_port   = 8080
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.signaling_https[0].arn
    container_name   = "signaling"
    container_port   = 8443
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.signaling_netsocket[0].arn
    container_name   = "signaling"
    container_port   = 1188
  }

  depends_on = [
    aws_lb_listener.signaling_http,
    aws_lb_listener.signaling_https,
    aws_lb_listener.signaling_netsocket,
    aws_iam_role_policy_attachment.ecs_task_execution,
  ]
}

resource "aws_ecs_task_definition" "media_ingress" {
  count = var.create_media ? 1 : 0

  family                   = "${var.stack_name}-${var.region_label}-media-ingress"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.media_task_cpu)
  memory                   = tostring(var.media_task_memory)
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  container_definitions    = local.media_ingress_container_definitions
}

resource "aws_ecs_task_definition" "media_egress" {
  count = var.create_media ? 1 : 0

  family                   = "${var.stack_name}-${var.region_label}-media-egress"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.media_task_cpu)
  memory                   = tostring(var.media_task_memory)
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  container_definitions    = local.media_egress_container_definitions
}

resource "aws_ecs_service" "media_ingress" {
  count = var.create_media ? 1 : 0

  name            = "${var.stack_name}-${var.region_label}-media-ingress"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.media_ingress[0].arn
  desired_count   = var.media_ingress_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  depends_on = [aws_iam_role_policy_attachment.ecs_task_execution]
}

resource "aws_ecs_service" "media_egress" {
  count = var.create_media ? 1 : 0

  name            = "${var.stack_name}-${var.region_label}-media-egress"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.media_egress[0].arn
  desired_count   = var.media_egress_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  depends_on = [aws_iam_role_policy_attachment.ecs_task_execution]
}
