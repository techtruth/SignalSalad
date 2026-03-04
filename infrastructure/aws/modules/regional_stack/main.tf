data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  az_names   = sort(data.aws_availability_zones.available.names)
  primary_az = try(local.az_names[0], null)

  udp_from = tonumber(split("-", var.media_udp_port_range)[0])
  udp_to   = tonumber(split("-", var.media_udp_port_range)[1])
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = var.ubuntu_ami_owners

  filter {
    name   = "name"
    values = [var.ubuntu_ami_name_pattern]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.stack_name}-${var.region_label}-vpc"
  }
}

resource "aws_subnet" "this" {
  count = local.primary_az == null ? 0 : 1

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.primary_az
  cidr_block              = cidrsubnet(var.vpc_cidr, var.subnet_newbits, 0)
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.stack_name}-${var.region_label}-${local.primary_az}-subnet"
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.stack_name}-${var.region_label}-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name = "${var.stack_name}-${var.region_label}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count = local.primary_az == null ? 0 : 1

  subnet_id      = aws_subnet.this[0].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "this" {
  name        = "${var.stack_name}-${var.region_label}-sg"
  description = "Ingress for web/signaling/media ports"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.stack_name}-${var.region_label}-sg"
  }
}

resource "aws_security_group_rule" "ssh" {
  count = (var.create_signaling || var.create_media) ? 1 : 0

  type              = "ingress"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  cidr_blocks       = [var.allowed_ssh_cidr]
  security_group_id = aws_security_group.this.id
}

resource "aws_security_group_rule" "http" {
  count = var.create_signaling ? 1 : 0

  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.this.id
}

resource "aws_security_group_rule" "https" {
  count = var.create_signaling ? 1 : 0

  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.this.id
}

resource "aws_security_group_rule" "signaling_tcp" {
  count = var.create_signaling ? 1 : 0

  type              = "ingress"
  from_port         = 1188
  to_port           = 1188
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.this.id
}

resource "aws_security_group_rule" "media_udp" {
  count = var.create_media ? 1 : 0

  type              = "ingress"
  from_port         = local.udp_from
  to_port           = local.udp_to
  protocol          = "udp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.this.id
}

resource "aws_security_group_rule" "egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.this.id
}

resource "aws_instance" "media" {
  count = var.create_media && local.primary_az != null ? 1 : 0

  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.media_instance_type
  availability_zone           = local.primary_az
  subnet_id                   = aws_subnet.this[0].id
  vpc_security_group_ids      = [aws_security_group.this.id]
  key_name                    = var.ssh_key_name
  associate_public_ip_address = true

  tags = {
    Name = "${var.stack_name}-${var.region_label}-media"
  }
}

resource "aws_instance" "signaling" {
  count = var.create_signaling && local.primary_az != null ? 1 : 0

  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.signaling_instance_type
  availability_zone           = local.primary_az
  subnet_id                   = aws_subnet.this[0].id
  vpc_security_group_ids      = [aws_security_group.this.id]
  key_name                    = var.ssh_key_name
  associate_public_ip_address = true

  tags = {
    Name = "${var.stack_name}-${var.region_label}-signaling"
  }
}
