const PageLoader = ({ message = 'Loading this page…' }) => (
  <section className="page-loader" aria-busy="true" aria-label={message}>
    <div className="page-loader__skeleton" aria-hidden="true">
      <div className="page-loader__eyebrow" />
      <div className="page-loader__heading" />
      <div className="page-loader__summary" />
      <div className="page-loader__grid">
        <div className="page-loader__card" />
        <div className="page-loader__card" />
        <div className="page-loader__card" />
      </div>
    </div>
    <p className="page-loader__status" role="status" aria-live="polite">{message}</p>
  </section>
);

export default PageLoader;
