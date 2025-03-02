# GitHub Workflow Setup Guide

The included GitHub workflow automates building and publishing your Docker image to both Docker Hub and GitHub Container Registry whenever you push to the main branch or create a new tag.

## Setting Up Repository Secrets

Before the workflow can run successfully, you need to set up the following secrets in your GitHub repository:

1. Navigate to your GitHub repository
2. Go to "Settings" → "Secrets and variables" → "Actions"
3. Add the following secrets:

| Secret Name | Description |
|-------------|-------------|
| `DOCKER_USERNAME` | Your Docker Hub username |
| `DOCKER_PASSWORD` | Your Docker Hub password or access token |

## Automatic Tagging

The workflow automatically creates Docker image tags based on:

- Git branches (e.g., `main`)
- Git tags (e.g., `v1.0.0`)
- Semantic versioning (e.g., `1.0.0`, `1.0`, `1`)
- Git commit SHA

## Usage

### For Development

- Pushing to `main` or `master` branch will build and publish images tagged with the branch name and commit SHA

### For Releases

- Create and push a Git tag with semantic versioning:
  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  ```
- This will create Docker images with tags: `1.0.0`, `1.0`, and `1`

## Example

After setting up the workflow, when you push a tag like `v1.2.3` to your repository, the following Docker images will be published:

- `yourusername/traefik-dns-manager:1.2.3`
- `yourusername/traefik-dns-manager:1.2`
- `yourusername/traefik-dns-manager:1`
- `ghcr.io/yourusername/traefik-dns-manager:1.2.3`
- `ghcr.io/yourusername/traefik-dns-manager:1.2`
- `ghcr.io/yourusername/traefik-dns-manager:1`
