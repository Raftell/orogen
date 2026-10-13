// ImportTerrain: steps 1 and 2 of export-unreal.md 8.3, then the hand-over to OrogenCreateLandscape. No landscape
// header is included here; the module itself is declared here too, because it has nothing to start or stop.
// This source has never been compiled or run: see README.md.

#include "OrogenImportLibrary.h"

#include "Editor.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "Misc/FileHelper.h"
#include "Modules/ModuleManager.h"

#include "OrogenLandscapeCompat.h"
#include "OrogenManifest.h"

IMPLEMENT_MODULE(FDefaultModuleImpl, OrogenBridge)

// A .r16 file is little-endian and its bytes are copied into the uint16 array as they are.
#if !PLATFORM_LITTLE_ENDIAN
#error "OrogenBridge copies little-endian .r16 samples into memory unchanged and so needs a little-endian host."
#endif

ALandscape* UOrogenImportLibrary::ImportTerrain(const FString& ManifestPath, const FString& MaterialPath,
                                                const FString& LayerInfoFolder, FString& OutError)
{
	OutError.Reset();

	// Step 1: the manifest, its layout against its resolution, and the sizes of the data files.
	FOrogenManifest Manifest;
	if (!OrogenLoadManifest(ManifestPath, Manifest, OutError))
	{
		return nullptr;
	}

	FString InfoFolder = LayerInfoFolder;
	while (InfoFolder.Len() > 1 && InfoFolder.EndsWith(TEXT("/")))
	{
		InfoFolder.LeftChopInline(1);
	}
	if (Manifest.Layers.Num() > 0 && (InfoFolder.Len() < 2 || !InfoFolder.StartsWith(TEXT("/"))))
	{
		OutError = FString::Printf(TEXT("The build has %d layers, so LayerInfoFolder must name a content folder such as /Game/Orogen/LayerInfos; it is \"%s\"."), Manifest.Layers.Num(), *LayerInfoFolder);
		return nullptr;
	}

	// [U] The editor's own world, as the research's sketch obtains it.
	// OPEN QUESTION: whether GetEditorWorldContext still takes this one argument on 5.8.
	UWorld* World = GEditor != nullptr ? GEditor->GetEditorWorldContext(false).World() : nullptr;
	if (World == nullptr)
	{
		OutError = TEXT("There is no editor world to create the landscape in.");
		return nullptr;
	}

	FOrogenLandscapeDesc Desc;
	Desc.Label = FString::Printf(TEXT("Orogen_%s"), *Manifest.Name);
	Desc.SizeX = Manifest.SizeX;
	Desc.SizeY = Manifest.SizeY;
	Desc.QuadsPerSection = Manifest.QuadsPerSection;
	Desc.SectionsPerComponent = Manifest.SectionsPerComponent;
	Desc.ActorLocationCm = Manifest.ActorLocationCm;
	Desc.ScaleCm = Manifest.ScaleCm;
	Desc.HeightSourcePath = Manifest.HeightR16File;
	Desc.MaterialPath = MaterialPath;
	Desc.LayerInfoFolder = InfoFolder;
	Desc.PartitionGridSize = Manifest.bWorldPartition ? Manifest.GridSize : 0;

	// Step 2: the heights. Sample (X, Y) of the file is index X + Y * SizeX of the array, row 0 first.
	// The manifest's checks bound SizeX * SizeY * 2 below 2^31, so the counts fit the arrays' int32.
	const int64 Samples = static_cast<int64>(Manifest.SizeX) * static_cast<int64>(Manifest.SizeY);
	{
		// [U] FFileHelper::LoadFileToArray as Gaea2Unreal and the research's sketch call it.
		TArray<uint8> Raw;
		if (!FFileHelper::LoadFileToArray(Raw, *Manifest.HeightR16File, 0) || static_cast<int64>(Raw.Num()) != Samples * 2)
		{
			OutError = FString::Printf(TEXT("Cannot read %lld height samples from %s."), Samples, *Manifest.HeightR16File);
			return nullptr;
		}
		Desc.Heights.SetNumUninitialized(static_cast<int32>(Samples));
		FMemory::Memcpy(Desc.Heights.GetData(), Raw.GetData(), static_cast<SIZE_T>(Raw.Num()));
	}

	// The weights of every layer, in the manifest's order: the base layer, the weight-blended layers, the others.
	Desc.Layers.Reserve(Manifest.Layers.Num());
	for (const FOrogenManifestLayer& Layer : Manifest.Layers)
	{
		FOrogenLandscapeLayerDesc& LayerDesc = Desc.Layers.AddDefaulted_GetRef();
		LayerDesc.Name = Layer.Name;
		LayerDesc.Blend = Layer.Blend;
		LayerDesc.SourcePath = Layer.R8File;
		if (!FFileHelper::LoadFileToArray(LayerDesc.Bytes, *Layer.R8File, 0) || static_cast<int64>(LayerDesc.Bytes.Num()) != Samples)
		{
			OutError = FString::Printf(TEXT("Cannot read %lld weights of the layer %s from %s."), Samples, *Layer.Name, *Layer.R8File);
			return nullptr;
		}
	}

	// Steps 3 to 8.
	return OrogenCreateLandscape(World, Desc, OutError);
}
