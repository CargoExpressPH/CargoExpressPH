import React from 'react';
import { Loader } from 'lucide-react';

const PageLoader = () => (
  <div className="flex-center flex-col" style={{ minHeight: '60vh', gap: '1rem' }}>
    <Loader size={40} className="text-primary animate-spin" />
    <p className="text-secondary text-sm font-medium">Loading…</p>
  </div>
);

export default PageLoader;
