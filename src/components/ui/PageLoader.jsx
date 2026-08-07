import React from 'react';
import { Loader } from 'lucide-react';

const PageLoader = () => (
  <div className="flex-center" style={{ minHeight: '60vh', flexDirection: 'column', gap: '1rem' }}>
    <Loader size={40} className="text-primary animate-spin" />
    <p className="text-secondary text-sm font-medium">Loading module...</p>
  </div>
);

export default PageLoader;
