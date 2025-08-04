#!/bin/bash
echo "DIRECTORY STRUCTURE" > tree-structure.txt
echo "==================" >> tree-structure.txt
find .. -type d -not -path "*/node_modules/*" -not -path "*/.git/*" | \
    sed 's|[^/]*/|- |g' | sort | head -100 >> tree-structure.txt
echo -e "\n✅ Tree structure saved to: tree-structure.txt"
