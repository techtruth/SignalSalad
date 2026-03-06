# Azure Terraform Scaffold

This folder is reserved for a future Azure provider implementation.

Suggested structure:

- `provider.tf`
- `versions.tf`
- `variables.tf`
- `main.tf`
- `outputs.tf`

Target parity with Tencent stack:

- one signaling region
- multiple media regions
- shared SSH/bootstrap strategy
- network and security controls for WebRTC/signaling ports
