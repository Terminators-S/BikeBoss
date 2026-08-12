import { useEffect, useMemo, useState } from 'react';
import { UserIcon } from './icons.jsx';

function initialsFor(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => Array.from(part)[0]).join('').toUpperCase();
}

export default function UserAvatar({ photoUrl, name, className = '' }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initials = useMemo(() => initialsFor(name), [name]);

  useEffect(() => {
    setImageFailed(false);
  }, [photoUrl]);

  return (
    <span className={`user-avatar ${className}`.trim()} aria-hidden="true">
      {photoUrl && !imageFailed ? (
        <img src={photoUrl} alt="" onError={() => setImageFailed(true)} />
      ) : initials ? (
        <span className="user-avatar-initials">{initials}</span>
      ) : (
        <UserIcon />
      )}
    </span>
  );
}
