# EFS：持久化反馈库（SQLite），挂到容器 /app/data。
# 这是解决「跨重新部署反馈丢失」的关键——EFS 是网络文件系统，
# 任务重建后仍指向同一份数据，不再随镜像覆盖。

resource "aws_efs_file_system" "feedback" {
  encrypted = true

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = {
    Name = "${var.app_name}-feedback"
  }
}

resource "aws_efs_mount_target" "feedback" {
  count           = length(var.private_subnet_ids)
  file_system_id  = aws_efs_file_system.feedback.id
  subnet_id       = var.private_subnet_ids[count.index]
  security_groups = [aws_security_group.efs.id]
}

# EFS 安全组：只放行 ECS 任务所在安全组访问 NFS(2049)。
resource "aws_security_group" "efs" {
  name        = "${var.app_name}-efs"
  description = "EFS 挂载点：仅允许 ECS 任务访问"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
