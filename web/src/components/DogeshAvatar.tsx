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
}

export const DogeshAvatar: React.FC<DogeshAvatarProps> = ({
  size = 76,
  showEditBadge = true,
  avatarUrl = '/brand/hob-mark.png',
  onEditClick,
  status,
  className = '',
  ringColor = 'ring-white',
}) => {
  const isDefault = !avatarUrl || avatarUrl === '/brand/hob-mark.png' || avatarUrl.includes('hob-mark');

  return (
    <div
      className={`relative inline-block select-none shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <div
        className="w-full h-full rounded-full overflow-hidden bg-white border border-[rgba(25,35,50,0.06)] flex items-center justify-center shadow-xs"
      >
        <img
          src={isDefault ? '/brand/hob-mark.png' : avatarUrl}
          alt="Agent avatar"
          className="w-full h-full object-contain p-1.5"
        />
      </div>

      {/* Edit pencil icon badge (bottom right) */}
      {showEditBadge && (
        <button
          type="button"
          onClick={onEditClick}
          title="Edit agent profile"
          className="absolute bottom-0 right-0 w-[24px] h-[24px] rounded-full bg-white hover:bg-[#F5F5F5] border border-[#E0E0E0] flex items-center justify-center text-[#253041] transition-colors cursor-pointer shadow-xs"
        >
          <Pencil size={12} strokeWidth={2.2} />
        </button>
      )}

      {/* Status dot badge when not in edit mode */}
      {!showEditBadge && status && (
        <span
          className={`absolute bottom-0 right-0 rounded-full ring-2 ${ringColor} ${
            size >= 60 ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5'
          } ${
            status === 'connected'
              ? 'bg-[#16CC8A]'
              : status === 'busy'
              ? 'bg-amber-400'
              : 'bg-[#8792A1]'
          }`}
          title={`Status: ${status}`}
        />
      )}
    </div>
  );
};
