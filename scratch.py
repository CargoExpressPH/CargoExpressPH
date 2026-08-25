import re

schema = open('supabase/schema.sql').read()
tables = re.findall(r'CREATE TABLE IF NOT EXISTS\s+([^\s]+)\s*\((.*?)\);', schema, re.DOTALL | re.IGNORECASE)

for table_name, table_body in tables:
    print(f"TABLE: {table_name}")
    # Print PKs
    lines = table_body.split('\n')
    for line in lines:
        line = line.strip()
        if not line or line.startswith('--'):
            continue
        print("  " + line)
    print("="*40)

