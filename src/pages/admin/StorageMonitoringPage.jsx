import PhotoStorageTab from './PhotoStorageTab';
import ErrorBoundarySection from '../../components/ui/ErrorBoundarySection';

const StorageMonitoringPage = () => {
  return (
    <div className="page-transition">
      <ErrorBoundarySection message="Photo storage monitoring failed to load.">
        <PhotoStorageTab />
      </ErrorBoundarySection>
    </div>
  );
};

export default StorageMonitoringPage;
