# ECR 仓库：存放容器镜像。
resource "aws_ecr_repository" "web" {
  name                 = var.app_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# 构建并推送镜像（本机执行，Terraform 不负责构建）：
#   docker build -t copilot-web:<tag> -f webapp/deploy/Dockerfile webapp
#   aws ecr get-login-password --region <region> | docker login --username AWS \
#     --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
#   docker tag  copilot-web:<tag> <account>.dkr.ecr.<region>.amazonaws.com/<name>:<tag>
#   docker push <account>.dkr.ecr.<region>.amazonaws.com/<name>:<tag>
