// What the plugin reads of an Orogen build manifest, `<Name>.orogen.json` (export-unreal.md section 6), and the
// checks of export-unreal.md 8.3 step 1. Core and Json only: no landscape type appears here.
// This source has never been compiled or run: see README.md.

#pragma once

#include "CoreMinimal.h"

/** `landscape.layers[].blend` of the manifest. */
enum class EOrogenLayerBlend : uint8
{
	None,      // "none": No Weight Blending, an independent mask
	Final,     // "final": Final Weight Blending (Legacy)
	Advanced,  // "advanced": Advanced Weight Blending
};

/** One entry of `landscape.layers`. */
struct FOrogenManifestLayer
{
	FString Name;
	FString R8File;  // absolute; uint8, row-major, row 0 first, SizeX * SizeY bytes
	EOrogenLayerBlend Blend = EOrogenLayerBlend::None;
};

/** The members of a manifest that the import uses. Everything else in the file is ignored. */
struct FOrogenManifest
{
	/** `<Name>` of `<Name>.orogen.json`. */
	FString Name;

	/** `resolution`: vertices per side. Equal to the layout's `Components * QuadsPerSection * SectionsPerComponent + 1`. */
	int32 SizeX = 0;
	int32 SizeY = 0;

	/** `landscape.layout`. */
	int32 QuadsPerSection = 0;
	int32 SectionsPerComponent = 0;
	int32 ComponentsX = 0;
	int32 ComponentsY = 0;

	/** `landscape.heightmap.r16`, absolute: uint16 little-endian, row-major, row 0 first, SizeX * SizeY samples. */
	FString HeightR16File;

	/** `landscape.transform.scaleCm` and `actorLocationCm`. The rotation of a manifest is zero. */
	FVector ScaleCm = FVector::OneVector;
	FVector ActorLocationCm = FVector::ZeroVector;

	/** `landscape.worldPartition.enabled` and `gridSize` (components per streaming proxy, per side). */
	bool bWorldPartition = false;
	int32 GridSize = 1;

	/** `landscape.layers`, in the manifest's order. */
	TArray<FOrogenManifestLayer> Layers;
};

/**
 * Reads and checks a manifest. Rejects any schema other than "orogen.unreal.landscape/1", a build that is not
 * complete or has no landscape, a layout that does not give the resolution, an orientation or rotation other
 * than the one Orogen writes, a file name that leaves the manifest's folder, and a data file whose size is not
 * what the resolution needs. Returns false with OutError set to one sentence.
 */
bool OrogenLoadManifest(const FString& ManifestPath, FOrogenManifest& OutManifest, FString& OutError);
