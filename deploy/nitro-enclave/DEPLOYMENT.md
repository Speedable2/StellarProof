# AWS Nitro Enclave Deployment Guide

## Overview

This guide provides step-by-step instructions for deploying the StellarProof verification worker inside an AWS Nitro Enclave with out-of-band attestation support.

**Phase 3 Milestone**: Full AWS Nitro Enclave production deployment for TEE-based verification and cryptographic attestation.

---

## Quick Start

### 1. Prerequisites

- Docker 20.10+
- AWS CLI 2.0+
- AWS Nitro Enclave CLI
- Node.js 20.x

### 2. Setup Environment

```bash
cd deploy/nitro-enclave
cp config/enclave-env.example .env
# Edit .env with your credentials
nano .env
```

### 3. Build and Test

```bash
# Build Docker image
docker build -t stellarproof/verification-worker:latest -f Dockerfile ../..

# Test locally
docker run --rm --env-file .env -p 8081:8081 stellarproof/verification-worker:latest
```

### 4. Deployment

```bash
# Push to ECR
./build-and-deploy.sh push-ecr

# Deploy to AWS (on EC2 with Nitro)
./build-and-deploy.sh deploy .env
```

---

## Architecture

The verification worker runs inside an isolated Nitro Enclave with:

- **Attestation Bootstrap**: Initializes keypair and vsock communication
- **Verification Worker**: Processes jobs from the blockchain
- **Health Check**: Monitors process and external connectivity
- **Out-of-band Attestation**: Cryptographic signing via Ed25519

---

## File Structure

```
deploy/nitro-enclave/
├── Dockerfile                  # Multi-stage production image
├── README.md                   # Project overview
├── DEPLOYMENT.md               # This deployment guide
├── build-and-deploy.sh         # Automated build/deploy helper
│
├── config/
│   ├── nitro-config.json       # Enclave configuration schema
│   └── enclave-env.example     # Environment variables template
│
└── scripts/
    ├── attestation-bootstrap.sh # Initialize attestation subsystem
    ├── init-enclave.sh          # Initialize verification worker
    └── health-check.sh          # Health monitoring endpoint
```

---

## Security Best Practices

- ✅ Store credentials in AWS Secrets Manager (not .env)
- ✅ Rotate credentials every 90 days
- ✅ Use VPC Security Groups to restrict access
- ✅ Enable VPC Flow Logs for audit
- ✅ Validate attestation document signatures

---

## Support

- **AWS Nitro Enclave Docs**: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitro-enclave.html
- **Stellar Soroban Docs**: https://developers.stellar.org/learn/soroban
- **StellarProof GitHub**: https://github.com/Tybravo/StellarProof

---

*Last updated: October 21, 2024*
*Version: 1.0.0*
