import React from 'react';
import { Pencil } from 'lucide-react';

interface DogeshAvatarProps {
  size?: number;
  showEditBadge?: boolean;
  avatarUrl?: string;
  onEditClick?: () => void;
  status?: 'connected' | 'idle' | 'busy' | 'disconnected';
  className?: string;
}

export const DogeshAvatar: React.FC<DogeshAvatarProps> = ({
  size = 76,
  showEditBadge = true,
  avatarUrl = '/brand/hob-mark.png',
  onEditClick,
  status,
  className = '',
}) => {
  return (
    <div
      className={`relative inline-block select-none ${className}`}
      style={{ width: size, height: size }}
    >
      <div
        className="w-full h-full rounded-full overflow-hidden border border-[#3b444f] bg-[#20262d] flex items-center justify-center"
      >
        <img
          src={avatarUrl || '/brand/hob-mark.png'}
          alt="Agent avatar"
          className="w-full h-full object-contain p-2"
        />
      </div>

      {/* Edit pencil icon badge (bottom right) */}
      {showEditBadge && (
        <button
          type="button"
          onClick={onEditClick}
          title="Edit agent profile"
          className="absolute bottom-0 right-0 w-[24px] h-[24px] rounded-full bg-[#261f18] hover:bg-[#342a20] border border-[#483727] flex items-center justify-center text-[#ff9e63] transition-colors cursor-pointer shadow-xs"
        >
          <Pencil size={12} strokeWidth={2.2} />
        </button>
      )}

      {/* Status dot badge when not in edit mode */}
      {!showEditBadge && status && (
        <span
          className={`absolute bottom-0 right-0 rounded-full ring-2 ring-[#120f0d] ${
            size >= 60 ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5'
          } ${
            status === 'connected'
              ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
              : status === 'busy'
              ? 'bg-amber-500 animate-pulse'
              : 'bg-[#5e5244]'
          }`}
          title={`Status: ${status}`}
        />
      )}
    </div>
  );
};
