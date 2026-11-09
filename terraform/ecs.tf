# ECS Fargate：集群 + 任务定义 + 服务 + IAM + 安全组。

resource "aws_ecs_cluster" "main" {
  name = var.app_name
}

# ---- IAM ---------------------------------------------------------------

# 任务执行角色：拉取 ECR 镜像、写日志、挂 EFS。
resource "aws_iam_role" "ecs_execution" {
  name = "${var.app_name}-ecs-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# 任务角色：访问 EFS（ReadWrite）。
resource "aws_iam_role" "ecs_task" {
  name = "${var.app_name}-ecs-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_efs" {
  name = "${var.app_name}-efs-access"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = [aws_efs_file_system.feedback.arn]
    }]
  })
}

# ---- 安全组 ------------------------------------------------------------

# ECS 任务安全组：8000 只对 ALB 放行；EFS 安全组放行本组。
resource "aws_security_group" "ecs" {
  name        = "${var.app_name}-ecs"
  description = "ECS 任务：8000 仅对 ALB 开放"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 8000
    to_port         = 8000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---- 任务定义 ----------------------------------------------------------

resource "aws_ecs_task_definition" "web" {
  family                   = var.app_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024" # 1 vCPU：进程内 ONNX + whisper 推理
  memory                   = "3072" # 3 GB：模型驻留 + 请求峰值
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = var.app_name
    image = "${aws_ecr_repository.web.repository_url}:${var.image_tag}"
    portMappings = [{ containerPort = 8000, protocol = "tcp" }]
    mountPoints = [{
      sourceVolume  = "feedback"
      containerPath = "/app/data"
      readOnly      = false
    }]
    environment = [
      { name = "COPILOT_DATA_DIR", value = "/app/data" },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status==200 else 1)\""]
      interval    = 30
      timeout     = 5
      startPeriod = 40
      retries     = 3
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/${var.app_name}"
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "web"
        "awslogs-create-group"  = "true"
      }
    }
  }])

  volume {
    name = "feedback"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.feedback.id
      root_directory     = "/"
      transit_encryption = "ENABLED"
    }
  }
}

# ---- 服务 --------------------------------------------------------------

resource "aws_ecs_service" "web" {
  name            = var.app_name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = var.app_name
    container_port   = 8000
  }

  depends_on = [aws_lb_listener.https]
}
