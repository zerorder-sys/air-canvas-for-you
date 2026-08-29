import './Loading.css';

export default function Loading({ message = 'Loading hand tracking model…' }) {
  return (
    <div className="loading-overlay">
      <div className="spinner" />
      <p>{message}</p>
    </div>
  );
}
