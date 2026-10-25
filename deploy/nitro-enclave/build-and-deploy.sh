#!/bin/bash
# =============================================================================
# AWS Nitro Enclave - Build and Deploy Helper Script
# =============================================================================
# Automates the complete build and deployment process for the verification
# worker inside an AWS Nitro Enclave.

set -e

# Configuration
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-stellarproof/verification-worker}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
FULL_IMAGE="$IMAGE_NAME:$IMAGE_TAG"
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Commands
cmd_build() {
    log_info "Building Docker image: $FULL_IMAGE"
    cd "$PROJECT_ROOT"
    docker build -f deploy/nitro-enclave/Dockerfile -t "$FULL_IMAGE" . || {
        log_error "Docker build failed"
        return 1
    }
    log_success "Docker image built successfully"
}

cmd_test() {
    local env_file="${1:-.env}"
    if [ ! -f "$env_file" ]; then
        log_error "Environment file not found: $env_file"
        return 1
    fi
    log_info "Running container with environment from: $env_file"
    docker run --rm --env-file "$env_file" -p 8081:8081 "$FULL_IMAGE"
}

cmd_push_ecr() {
    if [ -z "$AWS_ACCOUNT_ID" ]; then
        AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
    fi
    local ecr_registry="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
    local ecr_image="${ecr_registry}/${IMAGE_NAME}:${IMAGE_TAG}"
    
    log_info "Logging into ECR..."
    aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ecr_registry"
    
    log_info "Tagging image for ECR..."
    docker tag "$FULL_IMAGE" "$ecr_image"
    
    log_info "Pushing image to ECR..."
    docker push "$ecr_image"
    log_success "Image pushed to ECR: $ecr_image"
}

cmd_help() {
    cat << EOF
AWS Nitro Enclave Build and Deploy Helper

Usage: $0 [COMMAND] [OPTIONS]

Commands:
  build              Build Docker image locally
  test               Test Docker image locally
  push-ecr           Push image to AWS ECR
  help               Show this help message

Examples:
  $0 build
  $0 test .env
  $0 push-ecr

EOF
}

# Main
case "${1:-help}" in
    build) cmd_build ;;
    test) cmd_test "${2:-.env}" ;;
    push-ecr) cmd_push_ecr ;;
    help|--help|-h) cmd_help ;;
    *) log_error "Unknown command: $1"; cmd_help; exit 1 ;;
esac
