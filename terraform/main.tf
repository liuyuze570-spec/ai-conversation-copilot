# AWS 部署 Terraform 模板（参考骨架，未真实 apply）
#
# 依赖：已有 VPC（至少 2 公有 + 2 私有子网）、一个 Route53 托管域。
# 使用前替换：region、镜像 tag、域名、VPC/子网 ID。
# 仅做静态语法参考；真实部署前需在目标账号逐项核对。

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "app_name" {
  type    = string
  default = "copilot-web"
}

variable "image_tag" {
  type    = string
  default = "0.7.0-web.10"
}

variable "domain_name" {
  type        = string
  description = "托管在 Route53 的域名，例如 captions.example.com"
}

# 引用已有 VPC 与子网（避免从零建网络，减少真实部署的门槛）。
variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type    = list(string)
  default = []
}

variable "private_subnet_ids" {
  type    = list(string)
  default = []
}

variable "zone_id" {
  type        = string
  description = "Route53 托管域 ID（域名所在 zone）"
}
