import React from 'react';
import { Pencil } from 'lucide-react';

interface DogeshAvatarProps {
  size?: number;
  showEditBadge?: boolean;
  avatarUrl?: string;
  onEditClick?: () => void;
  status?: 'connected' | 'idle' | 'busy' | 'disconnected';
  className?: string;
  ringColor?: string;
  hideBorder?: boolean;
  hideStatusDot?: boolean;
}

export const DogeshAvatar: React.FC<DogeshAvatarProps> = ({
  size = 76,
  showEditBadge = true,
  avatarUrl = '/brand/hob-mark.png',
  onEditClick,
  status,
  className = '',
  ringColor = 'ring-white',
  hideBorder = false,
  hideStatusDot = false,
}) => {
  const isDefault = !avatarUrl || avatarUrl === '/brand/hob-mark.png' || avatarUrl.includes('hob-mark');

  return (
    <div
      className={`relative inline-block select-none shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <div
        className={`w-full h-full rounded-full overflow-hidden flex items-center justify-center ${
          hideBorder
            ? 'bg-idle-soft border-0 shadow-none'
            : 'bg-surface border border-line shadow-xs'
        }`}
      >
        <img
          src={isDefault ? '/brand/hob-mark.png' : avatarUrl}
          alt="Agent avatar"
          className="block w-full h-full object-cover"
        />
      </div>

      {/* Edit pencil icon badge (bottom right) */}
      {showEditBadge && (
        <button
          type="button"
          onClick={onEditClick}
          title="Edit agent profile"
          className="absolute bottom-0 right-0 w-[24px] h-[24px] rounded-full bg-surface hover:bg-sunken border border-line flex items-center justify-center text-code transition-colors cursor-pointer shadow-xs"
        >
          <Pencil size={12} strokeWidth={2.2} />
        </button>
      )}

      {/* Status dot badge when not in edit mode */}
      {!showEditBadge && !hideStatusDot && status && (
        <span
          className={`absolute bottom-0 right-0 rounded-full ring-2 ${ringColor} ${
            size >= 60 ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5'
          } ${
            status === 'connected'
              ? 'bg-ok-dot'
              : status === 'busy'
              ? 'bg-amber-400'
              : 'bg-faint'
          }`}
          title={`Status: ${status}`}
        />
      )}
    </div>
  );
};
