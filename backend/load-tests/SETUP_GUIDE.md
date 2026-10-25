# Load Test Setup Guide

This guide walks you through setting up and running the StellarProof backend load tests.

## Step 1: Ensure Backend Server is Running

The load tests require the backend server to be running. Start it in a separate terminal:

```bash
# From backend root
npm run dev

# Expected output:
# Server is running on port 4000
# MongoDB Connected: <cluster-url>
```

## Step 2: Install k6

### macOS
```bash
brew install k6
```

### Linux (Ubuntu/Debian)
```bash
sudo apt-get install k6
```

### Windows
```bash
choco install k6
```

### Verify Installation
```bash
k6 --version
```

## Step 3: Setup Environment Variables

Create a `.env.local` file in the `load-tests` directory:

```bash
cp .env.example .env.local
```

Edit `.env.local` with your settings:

```env
BASE_URL=http://localhost:4000
JWT_TOKEN=your_jwt_token_if_needed
KMS_VUS=50
WORKER_VUS=50
```

## Step 4: Install Load Test Dependencies

```bash
cd backend/load-tests
npm install
```

## Step 5: Run Development Tests

Start with a quick smoke test:

```bash
# Quick validation (5 VUs, 30 seconds)
npm run test:load:all:dev
```

Expected output:
```
 ✓ KMS Rotation test scenarios
 ✓ Worker Idempotency test scenarios
✓ Successful completion
```

## Step 6: Run Full Load Tests

Once smoke tests pass, run full tests:

```bash
# Standard load (50 VUs, 5 minutes)
npm run test:load:all

# Or individually:
npm run test:load:kms
npm run test:load:worker
```

## Verifying Success

### KMS Rotation Test
Look for:
- ✅ `http_req_failed: 0.00%` (100% success)
- ✅ `kms_rotation_success: 1.00` (100% success rate)
- ✅ Atomicity violations: 0
- ✅ Transaction errors: 0

### Worker Idempotency Test
Look for:
- ✅ `http_req_failed: 0.00%` (100% success)
- ✅ `worker_idempotency_success: 1.00` (100% success rate)
- ✅ Duplicate requests handled: 100%
- ✅ Idempotency violations: 0

## Troubleshooting

### "Connection Refused" Error
```bash
# Check if backend is running
curl http://localhost:4000/health

# If not running, start it:
npm run dev
```

### "k6 command not found"
```bash
# Reinstall k6
brew install k6  # or your OS equivalent

# Verify installation
k6 version
```

### Authentication Errors
```bash
# If tests require JWT, set the token:
export JWT_TOKEN="your_valid_jwt_token"
npm run test:load:all
```

### High Error Rate
1. Check backend logs for errors
2. Verify MongoDB connection
3. Reduce VU count: `KMS_VUS=10 npm run test:load:kms`
4. Check system resources (CPU, memory, disk)

## Test Scenarios

| Scenario | Command | VUs | Duration | Use Case |
|----------|---------|-----|----------|----------|
| Quick Test | `test:load:all:dev` | 5 | 30s | Development validation |
| Light Load | `test:load:all:light` | 10 | 1m | Quick check |
| Standard | `test:load:all` | 50 | 5m | Regular validation |
| Stress | `test:load:all:stress` | 100 | 5m | Production readiness |

## Next Steps

1. ✅ Verify basic functionality with dev tests
2. ✅ Run standard load tests
3. ✅ Review test results and metrics
4. ✅ Run stress tests for production validation
5. ✅ Document findings in the PR

## Additional Resources

- [Load Test README](./README.md) - Comprehensive documentation
- [k6 Documentation](https://k6.io/docs/)
- [StellarProof Architecture](../.context/ARCHITECTURE.md)
- [Backend Contributing Guide](../CONTRIBUTING.md)
