-- Allow public guests to view trip capacities since the schedules page is now public
GRANT EXECUTE ON FUNCTION public.get_trips_load(UUID[]) TO anon;
