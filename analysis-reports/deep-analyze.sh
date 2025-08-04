#!/bin/bash

echo "🔍 DEEP FOLDER ANALYSIS STARTING..."
echo "=================================="
FOLDER=".."
REPORT="analysis-$(date +%Y%m%d-%H%M%S).txt"

# Header
{
echo "CLOCKWORK PLATFORM DEEP ANALYSIS"
echo "Generated: $(date)"
echo "=================================="
echo ""

# 1. Complete file inventory
echo "📊 COMPLETE STATISTICS"
echo "-------------------"
echo "Total files: $(find $FOLDER -type f | wc -l)"
echo "Total directories: $(find $FOLDER -type d | wc -l)"
echo "Total size: $(du -sh $FOLDER | cut -f1)"
echo "Hidden files: $(find $FOLDER -name ".*" -type f | wc -l)"
echo "Symbolic links: $(find $FOLDER -type l | wc -l)"
echo ""

# 2. Detailed file type analysis
echo "📁 FILE TYPE ANALYSIS (ALL TYPES)"
echo "--------------------------------"
find $FOLDER -type f | sed 's/.*\.//' | grep -v "/" | sort | uniq -c | sort -rn | while read count ext; do
    printf "%-20s %6d files\n" ".$ext" "$count"
done
echo ""

# 3. Code analysis by language
echo "💻 CODE ANALYSIS BY LANGUAGE"
echo "----------------------------"
for ext in js jsx ts tsx py java cpp c h hpp css scss html vue svelte rb php go rs swift kt; do
    files=$(find $FOLDER -name "*.$ext" 2>/dev/null | wc -l)
    if [ $files -gt 0 ]; then
        lines=$(find $FOLDER -name "*.$ext" -exec cat {} + 2>/dev/null | wc -l)
        printf "%-15s %6d files %8d lines\n" "$ext" "$files" "$lines"
    fi
done
echo ""

# 4. Project detection
echo "🚀 PROJECT & FRAMEWORK DETECTION"
echo "--------------------------------"
echo "Node.js projects (package.json):"
find $FOLDER -name "package.json" -type f | while read pkg; do
    dir=$(dirname "$pkg")
    echo "  📦 $dir"
    if [ -f "$pkg" ]; then
        grep -E '"(react|vue|angular|next|nuxt|svelte|express|fastify)"' "$pkg" | head -3
    fi
done | head -20
echo ""

echo "Python projects:"
find $FOLDER -name "requirements.txt" -o -name "setup.py" -o -name "Pipfile" | head -10
echo ""

echo "Docker containers:"
find $FOLDER -name "Dockerfile" -o -name "docker-compose.yml" | head -10
echo ""

# 5. Large file analysis
echo "📏 SPACE USAGE ANALYSIS"
echo "----------------------"
echo "Files over 10MB:"
find $FOLDER -type f -size +10M -exec ls -lh {} \; | awk '{print $5, $9}' | sort -rh | head -20
echo ""

echo "Largest directories:"
du -h $FOLDER/* 2>/dev/null | sort -rh | head -15
echo ""

# 6. Duplicate file detection
echo "🔍 DUPLICATE FILE DETECTION"
echo "--------------------------"
echo "Files with same size (potential duplicates):"
find $FOLDER -type f -exec stat -f "%z %N" {} \; | sort -n | uniq -d -w 10 | head -20
echo ""

# 7. Code quality indicators
echo "🏗️ CODE QUALITY INDICATORS"
echo "-------------------------"
echo "TODO/FIXME/HACK comments:"
grep -r "TODO\|FIXME\|HACK" $FOLDER --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" --include="*.py" 2>/dev/null | wc -l
echo ""

echo "Console.log statements:"
grep -r "console\.log" $FOLDER --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l
echo ""

echo "Commented out code blocks (///):"
grep -r "^[[:space:]]*///" $FOLDER --include="*.js" --include="*.jsx" 2>/dev/null | wc -l
echo ""

# 8. Git analysis
echo "🔧 GIT REPOSITORY ANALYSIS"
echo "-------------------------"
find $FOLDER -name ".git" -type d | while read gitdir; do
    repo=$(dirname "$gitdir")
    echo "Repository: $repo"
    cd "$repo" 2>/dev/null && git log --oneline 2>/dev/null | head -5
    cd - >/dev/null
done
echo ""

# 9. Security scan
echo "🔒 SECURITY SCAN"
echo "---------------"
echo "Potential API keys/tokens:"
grep -r "api_key\|apikey\|api_token\|secret\|password" $FOLDER --include="*.js" --include="*.env" --include="*.json" 2>/dev/null | grep -v node_modules | wc -l
echo ""

echo "Environment files:"
find $FOLDER -name ".env*" -type f | head -10
echo ""

# 10. File age analysis
echo "📅 FILE AGE ANALYSIS"
echo "-------------------"
echo "Files modified in last 24 hours:"
find $FOLDER -type f -mtime -1 | wc -l
echo ""

echo "Files modified in last week:"
find $FOLDER -type f -mtime -7 | wc -l
echo ""

echo "Files not modified in 6 months:"
find $FOLDER -type f -mtime +180 | wc -l
echo ""

# 11. Special files
echo "🎯 SPECIAL FILES & PATTERNS"
echo "---------------------------"
echo "README files:"
find $FOLDER -iname "readme*" -type f | head -10
echo ""

echo "Configuration files:"
find $FOLDER -name "*.config.js" -o -name "*.conf" -o -name "*.yml" -o -name "*.yaml" | head -15
echo ""

echo "Test files:"
find $FOLDER -name "*.test.js" -o -name "*.spec.js" -o -name "*_test.py" | wc -l
echo ""

# 12. Technology stack summary
echo "🏗️ TECHNOLOGY STACK SUMMARY"
echo "---------------------------"
echo "Checking for frameworks..."
[ -f "$FOLDER/package.json" ] && echo "✓ Node.js detected"
find $FOLDER -name "*.py" | head -1 >/dev/null && echo "✓ Python detected"
find $FOLDER -name "Dockerfile" | head -1 >/dev/null && echo "✓ Docker detected"
find $FOLDER -name "*.java" | head -1 >/dev/null && echo "✓ Java detected"
find $FOLDER -name "*.go" | head -1 >/dev/null && echo "✓ Go detected"
find $FOLDER -name "*.rs" | head -1 >/dev/null && echo "✓ Rust detected"
grep -r "react" $FOLDER --include="package.json" 2>/dev/null | head -1 >/dev/null && echo "✓ React detected"
grep -r "vue" $FOLDER --include="package.json" 2>/dev/null | head -1 >/dev/null && echo "✓ Vue detected"
echo ""

} > "$REPORT"

echo "✅ Analysis complete! Report saved to: analysis-reports/$REPORT"
echo ""
echo "Quick summary:"
echo "-------------"
tail -20 "$REPORT"
