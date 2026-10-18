import React from 'react';

interface HLogoProps {
  size?: number;
  className?: string;
  color?: string;
}

export const HLogo: React.FC<HLogoProps> = ({
  size = 32,
  className = '',
  color = '#17191D',
}) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 select-none ${className}`}
      aria-label="h logo"
    >
      <path
        d="M7 5C7 3.89543 7.89543 3 9 3C10.1046 3 11 3.89543 11 5V12.1C12.4 10.1 14.8 9 17.5 9C22.2 9 25.5 12.3 25.5 17.5V26.5C25.5 27.6046 24.6046 28.5 23.5 28.5C22.3954 28.5 21.5 27.6046 21.5 26.5V17.8C21.5 14.5 19.5 12.8 16.8 12.8C13.8 12.8 11 14.8 11 18.2V26.5C11 27.6046 10.1046 28.5 9 28.5C7.89543 28.5 7 27.6046 7 26.5V5Z"
        fill={color}
      />
    </svg>
  );
};
