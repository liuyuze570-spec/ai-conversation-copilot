output "alb_dns_name" {
  description = "ALB 的 DNS 名（Route53 已指向它）"
  value       = aws_lb.web.dns_name
}

output "ecr_repository_url" {
  description = "ECR 仓库地址（构建/推送镜像用）"
  value       = aws_ecr_repository.web.repository_url
}

output "efs_file_system_id" {
  description = "EFS 文件系统 ID（反馈库持久卷）"
  value       = aws_efs_file_system.feedback.id
}

output "service_url" {
  description = "对外 HTTPS 地址"
  value       = "https://${var.domain_name}"
}
