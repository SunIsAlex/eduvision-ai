## EduVision operations

- Status: `sudo /usr/local/sbin/openclaw-eduvision-root status`
- Pull, build and deploy latest approved branch: `sudo /usr/local/sbin/openclaw-eduvision-root deploy`
- Service: `eduvision-ai.service`, loopback port `8791`
- Public host: not assigned yet. Do not install an Nginx site until the operator
  provides a dedicated, unused hostname.

Use only the commands above. Never read or print `/etc/eduvision-ai.env`.
