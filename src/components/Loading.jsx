import './Loading.css';

export default function Loading({ message }) {
  return (
    <div className="loading-overlay">
      <div className="spinner" />
      <p>{message || 'Loading hand tracking model...'}</p>
    </div>
  );
}
