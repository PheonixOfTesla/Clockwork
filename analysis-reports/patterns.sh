#!/bin/bash
{
echo "INTERESTING PATTERNS & FINDINGS"
echo "==============================="
echo ""

echo "🎯 Potential main entry points:"
find .. -name "index.js" -o -name "main.js" -o -name "app.js" -o -name "server.js" | head -10
echo ""

echo "📱 Mobile app files:"
find .. -name "*.swift" -o -name "*.kt" -o -name "*.dart" | head -10
echo ""

echo "🖼️ Image assets:"
echo "Total images: $(find .. -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" -o -name "*.gif" -o -name "*.svg" | wc -l)"
echo ""

echo "📚 Documentation:"
find .. -name "*.md" | grep -v node_modules | head -20
echo ""

echo "🔑 Database files:"
find .. -name "*.sql" -o -name "*.db" -o -name "*.sqlite" | head -10
echo ""

echo "🌐 API definitions:"
find .. -name "*.yaml" -o -name "*.yml" | grep -i "api\|swagger\|openapi" | head -10

} > patterns.txt
echo -e "\n✅ Patterns saved to: patterns.txt"
