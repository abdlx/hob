import React from 'react';
import { Pencil } from 'lucide-react';

interface DogeshAvatarProps {
  size?: number;
  showEditBadge?: boolean;
  avatarUrl?: string;
  onEditClick?: () => void;
}

export const DogeshAvatar: React.FC<DogeshAvatarProps> = ({
  size = 72,
  showEditBadge = true,
  avatarUrl = '/brand/hob-mark.png',
  onEditClick,
}) => {
  return (
    <div
      className="relative inline-block select-none"
      style={{ width: size, height: size }}
    >
      <div
        className="w-full h-full rounded-full overflow-hidden border border-[#2b2a27] shadow-xs bg-[#211a14] flex items-center justify-center"
      >
        <img
          src={avatarUrl || '/brand/hob-mark.png'}
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
          className="absolute bottom-0 right-0 w-[21px] h-[21px] rounded-full bg-[#1e1d1b] hover:bg-[#282724] border border-[#33322f] flex items-center justify-center text-white transition-colors cursor-pointer shadow-xs"
        >
          <Pencil size={10.5} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
};
