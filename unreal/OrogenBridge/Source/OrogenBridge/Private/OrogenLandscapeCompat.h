// The seam between the plugin and the engine's landscape API (export-unreal.md 8.4). Everything the rest of the
// plugin knows about creating a landscape is in this header; every landscape call is in OrogenLandscapeCompat.cpp.
// No landscape type other than the forward-declared ALandscape appears here.
// This source has never been compiled or run: see README.md.

#pragma once

#include "CoreMinimal.h"

#include "OrogenManifest.h"

class ALandscape;
class UWorld;

/** One target layer to create. */
struct FOrogenLandscapeLayerDesc
{
	FString Name;
	EOrogenLayerBlend Blend = EOrogenLayerBlend::None;
	/** SizeX * SizeY weights, 0..255, index X + Y * SizeX. */
	TArray<uint8> Bytes;
	/** The .r8 file the weights were read from; stored on the landscape as the layer's source file. */
	FString SourcePath;
};

/** Everything OrogenCreateLandscape needs, with the files already read. */
struct FOrogenLandscapeDesc
{
	/** The actor's label in the editor. */
	FString Label;

	/** Vertices per side: Components * QuadsPerSection * SectionsPerComponent + 1 on each axis. */
	int32 SizeX = 0;
	int32 SizeY = 0;
	int32 QuadsPerSection = 0;
	int32 SectionsPerComponent = 0;

	/** The actor's transform: vertex (0, 0) at code 32768, centimetres per quad and per 128 codes. No rotation. */
	FVector ActorLocationCm = FVector::ZeroVector;
	FVector ScaleCm = FVector::OneVector;

	/** SizeX * SizeY height codes, index X + Y * SizeX. */
	TArray<uint16> Heights;
	/** The .r16 file the heights were read from. */
	FString HeightSourcePath;

	TArray<FOrogenLandscapeLayerDesc> Layers;

	/** Object path of the landscape material, or empty for none. */
	FString MaterialPath;
	/** Content folder for the layer info assets, without a trailing slash. Used only when there are layers. */
	FString LayerInfoFolder;

	/** Components per streaming proxy and side; 0 leaves the landscape unpartitioned. Applied only in a World Partition world. */
	int32 PartitionGridSize = 0;
};

/**
 * Creates one ALandscape in World: steps 3 to 8 of export-unreal.md 8.3.
 * Returns the actor, or nullptr with OutError set and no actor left in the world.
 */
ALandscape* OrogenCreateLandscape(UWorld* World, const FOrogenLandscapeDesc& Desc, FString& OutError);
