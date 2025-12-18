---
name: Bug report
about: Create a report to help us improve
title: "[BUG] - "
labels: bug
assignees: actuallymentor

---

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. SSH into the machine
2. Run `bash ~/tpn-subnet/scripts/update_node.sh`
3. Inspect logs using `docker compose -f ~/tpn-subnet/federated-container/docker-compose.yml logs -f`
4. Wait for 2 minutes until you see the error "Error: you are not bullish enough"

**Log entry**

Please include logs of your issue in the codeblock below. You can generate a snippet using:

```bash
ERROR_TEXT="Insert your error here"
LINES_AROUND_ERROR=50
docker compose logs -f ~/tpn-subnet/federated-container/docker-compose.yml logs | grep -i -B $LINES_AROUND_ERROR -A $LINES_AROUND_ERROR "$ERROR_TEXT"
```

Your logs:

```bash
INSERT YOUR LOGS HERE
```

**Your environment**

- Operating system: ubuntu/debian/archbtw
- Node type: worker/pool/validator

**Additional context**
Add any other context about the problem here.
