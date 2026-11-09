# 网页版 AWS 部署方案（0.7.0-web.10）

> **如实声明**：本文是**可落地的部署方案 + 配置模板**，尚未在 AWS 上真实部署。
> 作者没有 AWS 账号凭据，未创建过任何 EC2/ECS/EFS 实例。方案依据是 Dockerfile
> 里已验证的约定（非 root 运行、健康检查、`COPILOT_DATA_DIR=/app/data`、`--proxy-headers`），
> 以及 WorkBuddy Sites 之外的标准 AWS 托管路径。真实部署前必须逐条核对接入方式。

---

## 1. 现状与目标

| 项 | 现状 |
|---|---|
| 线上托管 | WorkBuddy Sites（`https://en-zh-caption-helper.app.workbuddy.host/`） |
| 容器化 | Dockerfile + docker-compose 已写好，**未真实构建**（本机 Docker 未运行） |
| 反馈库持久化 | **实测不通过**：`server/data/feedback.sqlite3` 随源码上传覆盖线上库，跨重新部署丢失 |
| AWS | 无任何资源、无凭据 |

**目标**：给出一套能真正解决「反馈跨部署持久化」的 AWS 方案，并配套 Terraform 模板。

---

## 2. 架构选型

推荐 **ECS Fargate + ALB + EFS**（全托管、无需自管 EC2、按量计费），而不是 EC2：

| 方案 | 结论 |
|---|---|
| **ECS Fargate + EFS**（推荐） | 无服务器容器；EFS 挂到 `/app/data` 天然解决 SQLite 持久化；ALB 做 HTTPS 终结与健康检查 |
| EC2 + Docker | 需要自己维护系统补丁/安全组/自动伸缩，运维成本高，不建议一个单进程服务上 EC2 |
| Lambda | 不适合：本服务是常驻单进程、进程内加载 100MB+ 模型、需要本地磁盘，与 Lambda 模型不符 |

### 资源清单

| 资源 | 用途 |
|---|---|
| VPC + 2 个公有子网 | 承载 ALB |
| 2 个私有子网 | 承载 ECS 任务 |
| ALB + 目标组 + 监听器(443) | HTTPS 终结、健康检查 `/api/health` |
| ECS 集群（Fargate）+ 服务 + 任务定义 | 跑容器，端口 8000 |
| EFS 文件系统 + 挂载目标 | 挂到容器 `/app/data`，持久化反馈库 |
| ECR 仓库 | 存放镜像 `copilot-web:0.7.0-web.10` |
| ACM 证书 | 为域名签 HTTPS 证书（挂在 ALB 上） |
| Route 53 记录 | 域名指向 ALB |

> 说明：模型文件（faster-whisper-base + opus-mt-en-zh，约 200MB）**打进镜像**（Dockerfile
> 已经这么做了），EFS 只存反馈 SQLite，不存模型——避免冷启动从网络拉模型。

---

## 3. 关键：反馈持久化怎么解

Dockerfile 已经把反馈库落到 `COPILOT_DATA_DIR=/app/data` 并声明 `VOLUME`。在 ECS 上：

1. 任务定义的 `mountPoints` 把 EFS 文件系统挂到容器的 `/app/data`；
2. EFS 是网络文件系统，跨任务/跨重新部署都指向同一份数据；
3. 反馈库 `feedback.sqlite3` 从此不再随镜像覆盖丢失。

**唯一前提**：EFS 挂载点、安全组（放行 2049/NFS）、以及任务定义里的 `mountPoints`
三处都正确配置。Terraform 模板见第 5 节。

---

## 4. 部署步骤（手动，先在 AWS 控制台验证一次）

1. **构建并推送镜像**（本机或 EC2 构建机）：
   ```bash
   cd webapp
   docker build -t copilot-web:0.7.0-web.10 -f deploy/Dockerfile .
   aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
   docker tag copilot-web:0.7.0-web.10 <account>.dkr.ecr.us-east-1.amazonaws.com/copilot-web:0.7.0-web.10
   docker push <account>.dkr.ecr.us-east-1.amazonaws.com/copilot-web:0.7.0-web.10
   ```
2. 创建 EFS，记下 `file_system_id` 和两个私有子网的挂载目标。
3. 创建 ECS 集群（Fargate）、任务定义（见第 5 节 Terraform 或控制台），
   挂 EFS 到 `/app/data`，容器端口 8000。
4. 创建 ALB + 目标组（`/api/health` 健康检查，端口 8000），HTTPS 监听 443 转发到目标组。
5. 建 ACM 证书 + Route 53 记录指向 ALB。
6. 部署后验证：
   ```bash
   curl -s https://<域名>/api/health   # 期望 200，real.translate/transcribe=true
   ```
   提交一条反馈 → 重启 ECS 服务 → 用同一编号+凭证查询，**确认仍在**（这是关键验收）。

---

## 5. Terraform 模板

> 提供作为**参考骨架**，未在真实账号 `terraform apply` 过。变量、镜像地址、
> 域名、区域需替换。Region 默认 `us-east-1`。

`terraform/` 目录结构：

```
terraform/
  main.tf          # provider + 变量 + VPC/子网/安全组（简化为引用已有 VPC）
  ecr.tf           # ECR 仓库
  efs.tf           # EFS + 挂载目标
  ecs.tf           # ECS 集群 + 任务定义 + 服务 + IAM
  alb.tf           # ALB + 目标组 + 监听器
  outputs.tf       # 输出域名与关键 ID
```

关键任务定义片段（`ecs.tf`）：

```hcl
resource "aws_ecs_task_definition" "web" {
  family                   = "copilot-web"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"   # 1 vCPU：进程内 ONNX + whisper 推理需要
  memory                   = "3072"   # 3 GB：模型驻留 + 请求峰值
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "copilot-web"
    image = "${aws_ecr_repository.web.repository_url}:0.7.0-web.10"
    portMappings = [{ containerPort = 8000, protocol = "tcp" }]
    # 反馈库持久化：EFS 挂到 Dockerfile 声明的 /app/data
    mountPoints = [{
      sourceVolume  = "feedback"
      containerPath = "/app/data"
      readOnly      = false
    }]
    environment = [
      # 与 Dockerfile 一致；EFS 挂载已覆盖 /app/data，无需额外数据目录变量
      { name = "COPILOT_DATA_DIR", value = "/app/data" },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status==200 else 1)\""]
      interval    = 30
      timeout     = 5
      startPeriod = 40
      retries     = 3
    }
  }])

  volume {
    name = "feedback"
    efs_volume_configuration {
      file_system_id = aws_efs_file_system.feedback.id
      root_directory = "/"
    }
  }
}
```

EFS + 挂载目标（`efs.tf`）：

```hcl
resource "aws_efs_file_system" "feedback" {
  encrypted = true
  lifecycle_policy { transition_to_ia = "AFTER_30_DAYS" }
}

resource "aws_efs_mount_target" "feedback" {
  count           = 2
  file_system_id  = aws_efs_file_system.feedback.id
  subnet_id       = var.private_subnet_ids[count.index]
  security_groups = [aws_security_group.efs.id]
}

resource "aws_security_group" "efs" {
  # 放行 2049/NFS，来源限到 ECS 任务所在安全组
  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }
  egress { from_port = 0; to_port = 0; protocol = "-1"; cidr_blocks = ["0.0.0.0/0"] }
}
```

---

## 6. 成本粗估（us-east-1，2026-11 价格水平，仅供参考）

| 资源 | 规格 | 月成本（约） |
|---|---|---|
| ECS Fargate | 1 vCPU / 3 GB，假设常驻 1 任务 | ~$30–45 |
| ALB | 1 个 + 少量流量 | ~$18–22 |
| EFS | 反馈库很小（几 MB），Standard 类 | <$1 |
| ECR | 镜像 ~300MB 存储 | <$1 |
| Route53 + ACM | 域名 + 证书 | ~$0.5–1 |

**合计约 $50–70/月**。对比赛演示/低流量场景偏贵——若只是演示，可退一步：
用一台最小 EC2（t3.small + EBS 卷存反馈）约 $15–20/月，但需自管补丁与安全组。

---

## 7. 诚实边界（务必如实，不许宣称已完成）

- [ ] 镜像**未真实构建**（本机 Docker 守护进程未运行，`docker build` 未执行）。
- [ ] **未在 AWS 上部署**：无账号、无凭据，未创建任何资源。
- [ ] Terraform 模板**未 `terraform apply`**，仅静态校验语法。
- [ ] EFS 挂载 + SQLite 跨任务持久化**未实测**（WorkBuddy Sites 上是覆盖丢失，AWS 上
      理论上 EFS 可解，但未验证）。
- [ ] HTTPS 证书、ALB 健康检查、Fargate 冷启动、成本未实测。

**能写进「已完成」的只有**：Dockerfile（含非 root、健康检查、`--proxy-headers`）、
docker-compose、本方案文档、Terraform 参考模板、以及第 2 节的选型分析。
