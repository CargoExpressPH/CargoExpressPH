SELECT 
    t.table_name, 
    c.column_name, 
    c.data_type, 
    c.is_nullable, 
    c.column_default,
    pg_catalog.col_description(format('%I.%I', t.table_schema, t.table_name)::regclass::oid, c.ordinal_position) as col_desc
FROM 
    information_schema.tables t
JOIN 
    information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
WHERE 
    t.table_schema = 'public' 
    AND t.table_type = 'BASE TABLE'
ORDER BY 
    t.table_name, c.ordinal_position;
