import PhotoStorageTab from './PhotoStorageTab';
import ErrorBoundarySection from '../../components/ui/ErrorBoundarySection';

const StorageMonitoringPage = () => {
  return (
    <div className="page-transition">
      <ErrorBoundarySection message="Storage and usage monitoring failed to load.">
        <PhotoStorageTab />
      </ErrorBoundarySection>
    </div>
  );
};

export default StorageMonitoringPage;
