import { AIBackendProfile } from '@/sync/settings';
import { DEFAULT_PROFILES, getBuiltInProfile } from '@/sync/profileUtils';

export interface ProfileGroups {
    favoriteProfiles: AIBackendProfile[];
    customProfiles: AIBackendProfile[];
    builtInProfiles: AIBackendProfile[];
    favoriteIds: Set<string>;
    builtInIds: Set<string>;
}

export function buildProfileGroups({
    customProfiles,
    favoriteProfileIds,
}: {
    customProfiles: AIBackendProfile[];
    favoriteProfileIds: string[];
}): ProfileGroups {
    const builtInIds = new Set(DEFAULT_PROFILES.map((profile) => profile.id));
    const favoriteIds = new Set(favoriteProfileIds);

    const customById = new Map(customProfiles.map((profile) => [profile.id, profile] as const));

    const favoriteProfiles = favoriteProfileIds
        .map((id) => customById.get(id) ?? getBuiltInProfile(id))
        .filter(Boolean) as AIBackendProfile[];

    const nonFavoriteCustomProfiles = customProfiles.filter((profile) => !favoriteIds.has(profile.id));

    const nonFavoriteBuiltInProfiles = DEFAULT_PROFILES
        .map((profile) => getBuiltInProfile(profile.id))
        .filter(Boolean)
        .filter((profile) => !favoriteIds.has(profile.id)) as AIBackendProfile[];

    return {
        favoriteProfiles,
        customProfiles: nonFavoriteCustomProfiles,
        builtInProfiles: nonFavoriteBuiltInProfiles,
        favoriteIds,
        builtInIds,
    };
}

