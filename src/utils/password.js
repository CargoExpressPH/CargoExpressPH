export const getPasswordStrength = (pw) => {
  if (!pw) return { level: 0, label: '', color: '' };
  let score = 0;
  if (pw.length >= 8)  score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { level: 1, label: 'Weak',   color: 'var(--error)'   };
  if (score <= 2) return { level: 2, label: 'Fair',   color: 'var(--warning)' };
  if (score <= 3) return { level: 3, label: 'Good',   color: 'var(--info)'    };
  return              { level: 4, label: 'Strong', color: 'var(--success)'  };
};
