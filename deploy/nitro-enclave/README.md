# StellarProof Nitro Enclave Deployment Scaffold

## Overview

This directory contains a production-ready scaffold for deploying the StellarProof verification worker inside an **AWS Nitro Enclave** with **out-of-band attestation** support.

**Phase 3 Milestone**: Full AWS Nitro Enclave production deployment for TEE-based verification and cryptographic attestation.

---

## Quick Start

### 1. Prerequisites

- Docker 20.10+
- AWS CLI 2.0+
- AWS Nitro Enclave CLI
- Node.js 20.x (for local testing)
- OpenSSL 1.1.1+

### 2. Setup Environment

```bash
cd deploy/nitro-enclave
cp config/enclave-env.example .env
nano .env  # Edit with your credentials
```

**Required variables:**
- `MONGODB_URI`
- `STELLAR_RPC_URL`
- `ORACLE_CONTRACT_ID`
- `ORACLE_SECRET_KEY`
- `JWT_SECRET`
- `MASTER_KEY`

### 3. Build and Test

```bash
./build-and-deploy.sh build
./build-and-deploy.sh test .env
```

### 4. Deploy to AWS

```bash
./build-and-deploy.sh push-ecr
# On EC2 with Nitro support:
./build-and-deploy.sh deploy .env
```

---

## Directory Structure

```
deploy/nitro-enclave/
├── Dockerfile                      # Multi-stage Docker build
├── README.md                       # This file
├── DEPLOYMENT.md                   # Complete deployment guide
├── build-and-deploy.sh             # Automated build/deploy helper
│
├── config/
│   ├── nitro-config.json           # Enclave configuration schema
│   └── enclave-env.example         # Environment variables template
│
└── scripts/
    ├── attestation-bootstrap.sh    # Initialize attestation subsystem
    ├── init-enclave.sh             # Initialize verification worker
    └── health-check.sh             # Health monitoring endpoint
```

---

## Architecture

```
AWS EC2 Instance (Parent)
         ↕ (vsock:19600)
AWS Nitro Enclave (Isolated VM)
├── Attestation Bootstrap
│   ├── Environment detection
│   ├── Keypair generation (Ed25519)
│   └── Vsock listener setup
├── Verification Worker
│   ├── Manifest re-hash verification
│   ├── Attestation signing
│   └── Soroban transaction submission
└── Health Check (port 8081)
    ├── Process monitoring
    ├── Connectivity validation
    └── Resource tracking
```

---

## Configuration

### Environment Variables

See `config/enclave-env.example` for all options.

Key variables:
- `MONGODB_URI` - Database connection
- `STELLAR_RPC_URL` - Soroban RPC endpoint
- `ORACLE_CONTRACT_ID`, `PROVENANCE_CONTRACT_ID`, `REGISTRY_CONTRACT_ID`
- `ORACLE_SECRET_KEY` - Ed25519 key for signing
- `JWT_SECRET` - Authentication secret
- `MASTER_KEY` - KMS encryption key

### Enclave Configuration

JSON schema at `config/nitro-config.json`:
- Memory: 512 MB
- CPUs: 2
- Attestation: Out-of-band via vsock
- Worker concurrency: 4

---

## Usage Examples

### Build Locally
```bash
./build-and-deploy.sh build
```

### Test with Environment
```bash
./build-and-deploy.sh test .env
```

### Push to ECR
```bash
./build-and-deploy.sh push-ecr
```

---

## Security

✅ **Best Practices**
- Store credentials in AWS Secrets Manager (not .env files)
- Rotate credentials every 90 days
- Use VPC Security Groups to restrict access
- Enable VPC Flow Logs for audit
- Validate attestation document signatures
- Use Ed25519 cryptographic signing

✅ **Hardening**
- Non-root user execution (nodejs:1001)
- Minimal runtime image (~200 MB)
- No build tools in production image
- Dumb-init for proper signal handling

---

## Monitoring

### Health Check

```bash
curl http://localhost:8081/health
```

Expected response:
```json
{
  "status": "healthy",
  "worker": "running",
  "attestation": "bootstrapped"
}
```

### CloudWatch Logs

```bash
aws logs tail /aws/ec2/enclave/verification-worker --follow
```

---

## Troubleshooting

### Docker build fails
```bash
docker system prune -a
./build-and-deploy.sh build
```

### Enclave fails to start
```bash
dmesg | grep nitro  # Verify Nitro support
free -h             # Check available memory
```

### Worker not processing jobs
```bash
# Verify contract deployment
stellar contract invoke --id $ORACLE_CONTRACT_ID -- get_pending_requests

# Check RPC connectivity
curl $STELLAR_RPC_URL -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getNetwork"}'
```

---

## Documentation

- **DEPLOYMENT.md** - Complete step-by-step deployment guide
- **Dockerfile** - Multi-stage build for production
- **scripts/attestation-bootstrap.sh** - Attestation initialization
- **scripts/init-enclave.sh** - Worker initialization
- **scripts/health-check.sh** - Health monitoring
- **config/nitro-config.json** - Enclave configuration schema
- **config/enclave-env.example** - Environment variables template

---

## Support & Resources

- **AWS Nitro Enclave Docs**: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitro-enclave.html
- **Stellar Soroban Docs**: https://developers.stellar.org/learn/soroban
- **StellarProof GitHub**: https://github.com/Tybravo/StellarProof
- **See DEPLOYMENT.md**: For complete troubleshooting guide

---

## Contributing

Follow [CONTRIBUTING.md](../../CONTRIBUTING.md) guidelines when making changes.

---

*Last updated: October 21, 2024*
*Version: 1.0.0*
