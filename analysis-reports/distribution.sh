#!/bin/bash
echo "FILE TYPE DISTRIBUTION" > distribution.txt
echo "=====================" >> distribution.txt
echo "" >> distribution.txt
total=$(find .. -type f | wc -l)
find .. -type f -name "*.*" | sed 's/.*\.//' | sort | uniq -c | sort -rn | \
while read count ext; do
    percent=$((count * 100 / total))
    bar=$(printf '█%.0s' $(seq 1 $((percent / 2))))
    printf "%-10s %5d files [%-50s] %3d%%\n" ".$ext" "$count" "$bar" "$percent"
done >> distribution.txt
echo -e "\n✅ Distribution saved to: distribution.txt"
