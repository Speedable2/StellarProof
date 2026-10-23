# StellarProof Backend Load Tests

Comprehensive load and concurrency tests for validating transaction atomicity (KMS rotation) and worker idempotency under high-concurrency scenarios.

## Overview

This directory contains k6-based load tests designed to validate production-readiness of the StellarProof backend's critical workflows:

1. **KMS Rotation Concurrency Test** - Validates transaction atomicity and database consistency during key rotation
2. **Worker Idempotency Test** - Validates duplicate request handling and worker state consistency

### Objectives

- ✅ Validate transaction atomicity (all-or-nothing guarantee)
- ✅ Ensure worker idempotency (duplicate requests return identical results)
- ✅ Test database consistency under concurrent load
- ✅ Detect race conditions and partial state issues
- ✅ Measure performance under realistic concurrency patterns
- ✅ Verify error handling and recovery mechanisms

## Prerequisites

### Required Tools

- **k6** (v0.43.0+) - Load testing tool by Grafana
- **Node.js** (v16+) - JavaScript runtime
- **npm** or **pnpm** - Package manager

### Installation

#### Install k6

**macOS/Linux:**
```bash
# Using Homebrew (macOS)
brew install k6

# Using apt (Ubuntu/Debian)
sudo apt-get install k6

# Using yum (CentOS/RHEL)
sudo yum install k6
```

**Windows:**
```bash
# Using Chocolatey
choco install k6

# Or download binary from https://k6.io/docs/get-started/installation/
```

**Docker:**
```bash
docker run -v $PWD:/scripts grafana/k6:latest run /scripts/kms-rotation.load.js
```

#### Install Backend Load Test Dependencies

```bash
# From backend root
cd backend/load-tests
npm install

# Or from backend root
npm install
```

## Configuration

### Environment Variables

Create a `.env.local` file in the `load-tests` directory or set environment variables:

```bash
# Server configuration
BASE_URL=http://localhost:4000
NODE_ENV=test

# Authentication
JWT_TOKEN=your_jwt_token_here
TEST_USER_ID=test-user-001

# KMS Load Test Configuration
KMS_VUS=50                           # Virtual users
KMS_DURATION=5m                      # Test duration
KMS_RAMP_UP=1m                       # Ramp-up duration
KMS_BATCH_SIZE=5                     # Keys per batch
KMS_CONCURRENT_BATCHES=10            # Concurrent batches

# Worker Load Test Configuration
WORKER_VUS=50                        # Virtual users
WORKER_DURATION=5m                   # Test duration
WORKER_RAMP_UP=1m                    # Ramp-up duration
WORKER_DUPLICATE_REQUESTS=5          # Duplicate requests per VU
WORKER_DUPLICATE_DELAY=100           # Delay between duplicates (ms)

# General
THINK_TIME=1                         # Think time between operations (seconds)
```

### Configuration Files

- `utils/config.js` - Centralized configuration with defaults
- `utils/metrics.js` - Custom metric definitions
- `utils/helpers.js` - Shared utility functions

## Running the Tests

### Quick Start (Development)

Test with minimal load (5 VUs, 30 seconds):

```bash
# From backend root
npm run test:load:all:dev

# Or individual tests
npm run test:load:kms:dev
npm run test:load:worker:dev
```

### Standard Load Testing

Run with recommended settings (50 VUs, 5 minutes):

```bash
# All tests
npm run test:load:all

# KMS rotation test only
npm run test:load:kms

# Worker idempotency test only
npm run test:load:worker

# Sequential execution
npm run test:load:sequential
```

### Scenarios

#### Light Load
- VUs: 10
- Duration: 1 minute
- Best for: Quick validation, early development

```bash
npm run test:load:kms:light
npm run test:load:worker:light
npm run test:load:all:light
```

#### Standard Load
- VUs: 50
- Duration: 5 minutes
- Best for: Regular validation, CI/CD

```bash
npm run test:load:kms
npm run test:load:worker
npm run test:load:all
```

#### Stress Test
- VUs: 100
- Duration: 5 minutes
- Best for: Production readiness, edge cases

```bash
npm run test:load:kms:stress
npm run test:load:worker:stress
npm run test:load:all:stress
```

### Custom Configuration

Override any setting via environment variables:

```bash
# Custom VU count and duration
BASE_URL=http://localhost:4000 \
KMS_VUS=75 \
KMS_DURATION=10m \
npm run test:load:kms

# With authentication
BASE_URL=https://api.example.com \
JWT_TOKEN=eyJhbGciOiJIUzI1NiIs... \
npm run test:load:all
```

### Direct k6 Execution

For more advanced options, run k6 directly:

```bash
# With custom options
k6 run \
  --vus 100 \
  --duration 10m \
  --out json=results.json \
  scripts/kms-rotation.load.js

# With environment variables
k6 run \
  -e BASE_URL=http://localhost:4000 \
  -e KMS_VUS=50 \
  scripts/kms-rotation.load.js

# With stages (custom ramp profile)
k6 run \
  --stage 1m:10 \
  --stage 3m:50 \
  --stage 2m:0 \
  scripts/kms-rotation.load.js
```

## Test Scenarios

### 1. KMS Rotation Concurrency Test

**File:** `scripts/kms-rotation.load.js`

**What It Tests:**
- Transaction atomicity during concurrent key rotations
- Database consistency (all-or-nothing guarantee)
- Key version sequencing
- Asset re-encryption completion
- Proper handling of concurrent rotations on the same user

**Key Validations:**
1. ✅ Active key changes after rotation
2. ✅ Old key is deactivated
3. ✅ New key version is sequential (v1 → v2 → v3)
4. ✅ Re-encrypted asset count matches database
5. ✅ No atomicity violations (partial states)

**Metrics Tracked:**
- `kms_rotations_total` - Total rotation operations
- `kms_rotation_success` - Success rate
- `kms_rotation_duration_ms` - Operation duration
- `kms_atomicity_violations` - Atomicity issues
- `kms_transaction_errors` - Transaction failures
- `kms_re_encrypted_assets` - Assets rotated per operation
- `db_transaction_duration_ms` - Database transaction time

**Success Criteria:**
- ✅ 95%+ HTTP success rate
- ✅ Zero atomicity violations
- ✅ p95 response time < 5 seconds
- ✅ No partial state issues

**Load Profile:**
```
1m: Ramp up to 25% VUs
1m: Ramp up to 50% VUs
2m: Full load (100% VUs)
2m: Hold full load
1m: Ramp down to 0
```

### 2. Worker Idempotency Test

**File:** `scripts/worker-idempotency.load.js`

**What It Tests:**
- Duplicate request handling
- Idempotent response consistency
- Worker state consistency across retries
- Race conditions in concurrent processing
- Job state stability

**Key Validations:**
1. ✅ Duplicate requests return identical responses
2. ✅ Jobs are not processed multiple times
3. ✅ Job state remains consistent across requests
4. ✅ No orphaned or inconsistent records
5. ✅ Concurrent duplicates handled correctly

**Metrics Tracked:**
- `worker_requests_total` - Total requests
- `worker_idempotency_success` - Idempotency rate
- `worker_duplicate_handled` - Duplicate handling rate
- `worker_idempotency_violations` - Idempotency issues
- `worker_processing_time_ms` - Job processing duration
- `worker_duplicate_requests` - Duplicate request count

**Success Criteria:**
- ✅ 95%+ HTTP success rate
- ✅ 100% idempotent responses
- ✅ Zero duplicate processing
- ✅ p95 response time < 5 seconds

**Load Profile:**
```
1m: Ramp up to 25% VUs
1m: Ramp up to 50% VUs
2m: Full load (100% VUs)
2m: Hold full load
1m: Ramp down to 0
```

## Interpreting Results

### Output Metrics

k6 provides detailed metrics in the console output:

```
✓ checks
✓ data_received
✓ data_sent
✓ http_req_duration
✓ http_req_failed
✓ http_reqs
✓ iteration_duration
✓ iterations
✓ vus
✓ vus_max
```

### Custom Metrics

Load tests include custom metrics for business logic validation:

**KMS Metrics:**
- `kms_atomicity_violations` - Should be 0
- `kms_transaction_errors` - Should be 0
- `kms_rotation_success` - Should be > 95%

**Worker Metrics:**
- `worker_idempotency_violations` - Should be 0
- `worker_duplicate_handled` - Should be 100%
- `worker_idempotency_success` - Should be > 95%

### Analysis

1. **Success Rate:**
   - ✅ Good: > 99%
   - ⚠️ Warning: 95-99%
   - ❌ Critical: < 95%

2. **Response Time (p95):**
   - ✅ Good: < 2s
   - ⚠️ Warning: 2-5s
   - ❌ Critical: > 5s

3. **Atomicity/Idempotency:**
   - ✅ Good: 0 violations
   - ⚠️ Warning: 1-5 violations
   - ❌ Critical: > 5 violations

4. **Error Types:**
   - `http_req_failed` - HTTP errors (4xx, 5xx)
   - `timeout` - Request timeouts
   - `network_errors` - Connection issues

## Debugging

### Verbose Output

Run with detailed logging:

```bash
k6 run -v scripts/kms-rotation.load.js
```

### JSON Report

Export results for analysis:

```bash
k6 run --out json=results.json scripts/kms-rotation.load.js
```

### Common Issues

#### Connection Refused
- Ensure backend server is running on `BASE_URL`
- Check firewall and network settings
- Verify JWT token is valid (if required)

#### Atomicity Violations
- Check MongoDB connection string
- Verify replica set is configured
- Review transaction timeout settings
- Check for concurrent writes on the same user

#### Idempotency Failures
- Verify worker is handling duplicates correctly
- Check request deduplication logic
- Review job state persistence
- Ensure database indexes are present

#### Timeout Errors
- Reduce VU count or test duration
- Increase timeouts in config.js
- Check backend performance
- Verify database performance

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: Load Tests

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM UTC

jobs:
  load-tests:
    runs-on: ubuntu-latest
    services:
      mongodb:
        image: mongo:5
        options: >-
          --health-cmd mongosh
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 27017:27017

    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Start Backend Server
        run: |
          npm install
          npm run dev &
          sleep 5

      - name: Run Load Tests
        run: |
          cd backend/load-tests
          npm install
          npm run test:load:all:light
        env:
          BASE_URL: http://localhost:4000
          MONGODB_URI: mongodb://localhost:27017/stellarproof

      - name: Upload Results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: load-test-results
          path: backend/load-tests/results.json
```

## Best Practices

### Before Running Tests

1. ✅ Ensure backend server is healthy
2. ✅ Verify database connection and replica set
3. ✅ Check that no other tests are running
4. ✅ Monitor server resources (CPU, memory, disk)
5. ✅ Create test data/users as needed

### During Tests

1. 📊 Monitor backend logs in parallel
2. 📊 Watch system metrics (CPU, memory, DB)
3. 📊 Check database connection pool usage
4. 📊 Verify no resource exhaustion

### After Tests

1. 📋 Review results summary
2. 📋 Check for atomicity/idempotency violations
3. 📋 Analyze error patterns
4. 📋 Document findings in issue comments

### Performance Tuning

- Start with low VUs, gradually increase
- Monitor resource utilization at each level
- Identify bottlenecks using backend metrics
- Optimize database queries/indexes as needed

## Troubleshooting

### Test Fails with "Connection Refused"

```bash
# Verify backend is running
curl http://localhost:4000/health

# Check if port is in use
lsof -i :4000  # macOS/Linux
netstat -ano | findstr :4000  # Windows
```

### High Failure Rate

1. Check backend logs: `npm run dev` output
2. Verify database connectivity: Check MongoDB URI
3. Review request timestamps for patterns
4. Reduce VU count to isolate issue

### Memory/Resource Issues

1. Reduce VU count: `KMS_VUS=10`
2. Shorten duration: `KMS_DURATION=1m`
3. Increase think time: `THINK_TIME=2`
4. Monitor system resources during test

## Contributing

When adding new load tests:

1. Follow the existing structure
2. Add comprehensive checks and validations
3. Include setup/teardown hooks
4. Document test objectives and criteria
5. Add metrics for business logic validation
6. Update this README with test details

## References

- [k6 Documentation](https://k6.io/docs/)
- [k6 HTTP API Reference](https://k6.io/docs/javascript-api/k6-http/)
- [k6 Metrics](https://k6.io/docs/using-k6/metrics/)
- [StellarProof Architecture](../.context/ARCHITECTURE.md)
- [Backend Contributing Guide](../CONTRIBUTING.md)

## Support

For issues or questions:

1. Check logs: `npm run dev` output
2. Review this README
3. Check k6 documentation
4. Create issue on GitHub with:
   - Test output/logs
   - Environment details
   - Steps to reproduce
   - Expected vs actual behavior
