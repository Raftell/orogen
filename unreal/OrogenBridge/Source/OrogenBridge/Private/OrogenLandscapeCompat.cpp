// Steps 3 to 8 of export-unreal.md 8.3: creating the layer info assets, the actor, the landscape components, the
// target layers and the World Partition grid. This is the only file of the plugin that includes a Landscape or
// AssetTools header or names an engine version. Supporting another engine version means editing this file.
//
// THIS SOURCE HAS NEVER BEEN COMPILED OR RUN. It was written from Epic's API reference for Unreal Engine 5.8 and
// from a reading of the open-source Gaea2Unreal plugin, without the engine's source and without an engine to
// build against. Expect compile errors here first. See README.md.
//
// The marks on the calls below:
//   [E]  The declaration was read on Epic's C++ API reference for 5.8. That confirms the signature and nothing
//        else: not what the function does, not its default arguments (so every argument is passed explicitly),
//        and not which header declares it unless the comment says so.
//   [U]  Unverified for 5.8. The call follows Gaea2Unreal, whose source has no build for 5.8, or the sketch in
//        docs/research/unreal-landscape.md. Each such call states its open question.

#include "OrogenLandscapeCompat.h"

#include "Runtime/Launch/Resources/Version.h"

#if ENGINE_MAJOR_VERSION != 5 || ENGINE_MINOR_VERSION != 8
#error "OrogenBridge was written against the Unreal Engine 5.8 API reference and has never been compiled. The landscape API changes in almost every engine release: check every call in OrogenLandscapeCompat.cpp against the headers of your engine, then change this guard on purpose."
#endif

// OPEN QUESTION (headers): the API reference names LandscapeProxy.h, LandscapeLayerInfoObject.h and
// LandscapeSubsystem.h. That ALandscape is declared in Landscape.h and ULandscapeInfo in LandscapeInfo.h, and
// which of these headers declare FLandscapeImportLayerInfo, FLandscapeTargetLayerSettings, FLandscapeLayer,
// ELandscapeImportAlphamapType and ELandscapeTargetLayerBlendMethod, was not read anywhere.
#include "AssetToolsModule.h"
#include "Editor.h"
#include "Engine/World.h"
#include "IAssetTools.h"
#include "Landscape.h"
#include "LandscapeInfo.h"
#include "LandscapeLayerInfoObject.h"
#include "LandscapeProxy.h"
#include "LandscapeSubsystem.h"
#include "Materials/MaterialInterface.h"
#include "Misc/PackageName.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogOrogenBridge, Log, All);

namespace
{
	/**
	 * The blend method of a manifest layer.
	 * [E] PremultipliedAlphaBlending, read on the C++ page of ULandscapeLayerInfoObject, and that it is Advanced Weight Blending.
	 * [U] None and FinalWeightBlending: inferred from the Python enum's NONE and FINAL_WEIGHT_BLENDING, which was
	 *     read (docs/research/unreal-landscape.md, row 15); the C++ enum's own page was not. If either does not
	 *     compile, the enum's declaration in LandscapeLayerInfoObject.h gives the names.
	 */
	ELandscapeTargetLayerBlendMethod BlendMethodOf(EOrogenLayerBlend Blend)
	{
		switch (Blend)
		{
		case EOrogenLayerBlend::Final:
			return ELandscapeTargetLayerBlendMethod::FinalWeightBlending;
		case EOrogenLayerBlend::Advanced:
			return ELandscapeTargetLayerBlendMethod::PremultipliedAlphaBlending;
		case EOrogenLayerBlend::None:
		default:
			return ELandscapeTargetLayerBlendMethod::None;
		}
	}

	/**
	 * Step 3: the layer info asset `<Layer>_LayerInfo` in the folder. An asset of that name which already is a
	 * layer info is reused, with its name and blend method set again; anything else under that name is an error.
	 */
	ULandscapeLayerInfoObject* FindOrCreateLayerInfo(const FString& Folder, const FOrogenLandscapeLayerDesc& Layer, FString& OutError)
	{
		const FString AssetName = Layer.Name + TEXT("_LayerInfo");
		const FString ObjectPath = FString::Printf(TEXT("%s/%s.%s"), *Folder, *AssetName, *AssetName);

		ULandscapeLayerInfoObject* LayerInfo = nullptr;

		// An asset of that name may exist in memory, unsaved, or on disk. Each call is made with its leading
		// arguments only, which have not changed for many engine versions.
		// [U] OPEN QUESTION: whether FindObject, DoesPackageExist and LoadObject still take these on 5.8.
		UObject* Existing = FindObject<UObject>(nullptr, *ObjectPath);
		if (Existing == nullptr && FPackageName::DoesPackageExist(Folder / AssetName))
		{
			Existing = LoadObject<UObject>(nullptr, *ObjectPath);
		}
		if (Existing != nullptr)
		{
			LayerInfo = Cast<ULandscapeLayerInfoObject>(Existing);
			if (LayerInfo == nullptr)
			{
				OutError = FString::Printf(TEXT("%s exists and is not a landscape layer info; choose another folder for the layer infos."), *ObjectPath);
				return nullptr;
			}
		}
		else
		{
			// [U] As Gaea2Unreal creates its layer infos: a null factory makes a plain object of the class.
			// OPEN QUESTION: whether CreateAsset still takes these four arguments on 5.8 and never opens a dialog.
			IAssetTools& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
			LayerInfo = Cast<ULandscapeLayerInfoObject>(AssetTools.CreateAsset(AssetName, Folder, ULandscapeLayerInfoObject::StaticClass(), nullptr));
			if (LayerInfo == nullptr)
			{
				OutError = FString::Printf(TEXT("Cannot create the layer info asset %s."), *ObjectPath);
				return nullptr;
			}
		}

		// [E] SetLayerName(const FName&, bool bInModify) and SetBlendMethod(ELandscapeTargetLayerBlendMethod, bool bInModify).
		// The public properties behind them are announced to become private in 5.9, so only the setters are used.
		// No blend group is set: layers with an empty group name form one group.
		LayerInfo->SetLayerName(FName(*Layer.Name), true);
		LayerInfo->SetBlendMethod(BlendMethodOf(Layer.Blend), true);
		return LayerInfo;
	}
}

ALandscape* OrogenCreateLandscape(UWorld* World, const FOrogenLandscapeDesc& Desc, FString& OutError)
{
	OutError.Reset();
	if (World == nullptr)
	{
		OutError = TEXT("There is no world to create the landscape in.");
		return nullptr;
	}

	// The description must be whole before anything is created: every array holds SizeX * SizeY samples.
	const int64 Samples = static_cast<int64>(Desc.SizeX) * static_cast<int64>(Desc.SizeY);
	if (Desc.SizeX < 2 || Desc.SizeY < 2 || static_cast<int64>(Desc.Heights.Num()) != Samples)
	{
		OutError = FString::Printf(TEXT("The heights are %d samples and the landscape is %d x %d."), Desc.Heights.Num(), Desc.SizeX, Desc.SizeY);
		return nullptr;
	}
	for (const FOrogenLandscapeLayerDesc& Layer : Desc.Layers)
	{
		if (static_cast<int64>(Layer.Bytes.Num()) != Samples)
		{
			OutError = FString::Printf(TEXT("The layer %s is %d samples and the landscape is %d x %d."), *Layer.Name, Layer.Bytes.Num(), Desc.SizeX, Desc.SizeY);
			return nullptr;
		}
	}
	if (Desc.Layers.Num() > 0 && Desc.LayerInfoFolder.IsEmpty())
	{
		OutError = TEXT("The build has layers and no content folder was given for their layer info assets.");
		return nullptr;
	}

	// The material is loaded first, so that a wrong path fails before any asset or actor exists.
	// [U] LoadObject as the research's sketch uses it.
	UMaterialInterface* Material = nullptr;
	if (!Desc.MaterialPath.IsEmpty())
	{
		Material = LoadObject<UMaterialInterface>(nullptr, *Desc.MaterialPath);
		if (Material == nullptr)
		{
			OutError = FString::Printf(TEXT("Cannot load the landscape material %s."), *Desc.MaterialPath);
			return nullptr;
		}
	}

	// Step 3. One FLandscapeImportLayerInfo per layer, each with a layer info asset of its own.
	// [E] FLandscapeImportLayerInfo(FName) and its members LayerName, LayerInfo, SourceFilePath, LayerData.
	TArray<FLandscapeImportLayerInfo> ImportLayers;
	ImportLayers.Reserve(Desc.Layers.Num());
	for (const FOrogenLandscapeLayerDesc& Layer : Desc.Layers)
	{
		ULandscapeLayerInfoObject* LayerInfo = FindOrCreateLayerInfo(Desc.LayerInfoFolder, Layer, OutError);
		if (LayerInfo == nullptr)
		{
			return nullptr;
		}
		FLandscapeImportLayerInfo ImportLayer(FName(*Layer.Name));
		ImportLayer.LayerInfo = LayerInfo;
		ImportLayer.SourceFilePath = Layer.SourcePath;
		ImportLayer.LayerData = Layer.Bytes;
		ImportLayers.Add(MoveTemp(ImportLayer));
	}

	// Step 4. The actor stands at vertex (0, 0), unrotated.
	// [U] Spawned, given its material and scaled as Gaea2Unreal does it.
	// OPEN QUESTIONS: whether LandscapeMaterial and StaticLightingLOD are still public members that may be
	// assigned on 5.8, and whether a landscape must be told anything else before Import.
	ALandscape* Landscape = World->SpawnActor<ALandscape>(Desc.ActorLocationCm, FRotator::ZeroRotator, FActorSpawnParameters());
	if (Landscape == nullptr)
	{
		OutError = TEXT("The editor world did not spawn a Landscape actor.");
		return nullptr;
	}
	Landscape->LandscapeMaterial = Material;
	Landscape->SetActorRelativeScale3D(Desc.ScaleCm);
	// Gaea2Unreal's value: 2 for 8129 x 8129.
	Landscape->StaticLightingLOD = static_cast<int32>(FMath::DivideAndRoundUp(FMath::CeilLogTwo(static_cast<uint32>(Samples / (2048 * 2048) + 1)), static_cast<uint32>(2)));

	// Step 5. The heights and the layers each go in under a default FGuid, as the editor and Gaea2Unreal pass them.
	// [E] The twelve-parameter ALandscapeProxy::Import, ELandscapeImportAlphamapType::Additive.
	// OPEN QUESTIONS, which only a run answers: whether Import with no import layers creates the default edit
	// layer by itself; whether the data under the default FGuid ends up in that layer; whether this path shows
	// the repeated-tile fault reported for 8129 x 8129 imports into World Partition levels.
	TMap<FGuid, TArray<uint16>> HeightsByEditLayer;
	HeightsByEditLayer.Add(FGuid(), Desc.Heights);
	TMap<FGuid, TArray<FLandscapeImportLayerInfo>> LayersByEditLayer;
	const TArray<FLandscapeImportLayerInfo>& Imported = LayersByEditLayer.Add(FGuid(), MoveTemp(ImportLayers));

	Landscape->Import(
		FGuid::NewGuid(),
		0, 0, Desc.SizeX - 1, Desc.SizeY - 1,
		Desc.SectionsPerComponent, Desc.QuadsPerSection,
		HeightsByEditLayer, *Desc.HeightSourcePath,
		LayersByEditLayer, ELandscapeImportAlphamapType::Additive,
		TArrayView<const FLandscapeLayer>());

	// Step 6. The target layers.
	// [E] GetLandscapeInfo(), UpdateLayerInfoMap(ALandscapeProxy*, bool bInvalidate).
	ULandscapeInfo* LandscapeInfo = Landscape->GetLandscapeInfo();
	if (LandscapeInfo == nullptr)
	{
		// [U] OPEN QUESTION: whether destroying the actor here also removes whatever Import registered for it.
		World->EditorDestroyActor(Landscape, true);
		OutError = TEXT("The import created no landscape info; the landscape was removed again.");
		return nullptr;
	}
	LandscapeInfo->UpdateLayerInfoMap(Landscape, false);

	// [U] Gaea2Unreal registers the components here, between the layer info map and the target layers.
	// OPEN QUESTION: whether 5.8 needs it; Import may already have done it.
	Landscape->RegisterAllComponents();

	// [E] AddTargetLayer(const FName&, const FLandscapeTargetLayerSettings&, bool bPostEditChange) and
	// FLandscapeTargetLayerSettings(ULandscapeLayerInfoObject*, const FString&). Gaea2Unreal's source says the
	// call is required for a weightmap import from 5.5 on.
	for (const FLandscapeImportLayerInfo& Layer : Imported)
	{
		Landscape->AddTargetLayer(Layer.LayerName, FLandscapeTargetLayerSettings(Layer.LayerInfo.Get(), Layer.SourceFilePath), true);
	}

	// Two looks at what the import made, as warnings in the log and never as a failure: their behaviour is as
	// unverified as the import's. They answer open questions on the first run.
	// [E] ALandscape::GetEditLayer(int32) const; ULandscapeInfo::GetLandscapeExtent(int32&, int32&, int32&, int32&) const.
	const int32 FirstEditLayer = 0;
	if (Landscape->GetEditLayer(FirstEditLayer) == nullptr)
	{
		UE_LOG(LogOrogenBridge, Warning, TEXT("The imported landscape has no edit layer: Import did not create the default one."));
	}
	int32 MinX = 0, MinY = 0, MaxX = 0, MaxY = 0;
	if (!LandscapeInfo->GetLandscapeExtent(MinX, MinY, MaxX, MaxY) || MaxX - MinX != Desc.SizeX - 1 || MaxY - MinY != Desc.SizeY - 1)
	{
		UE_LOG(LogOrogenBridge, Warning, TEXT("The imported landscape reports the extent %d..%d x %d..%d; %d x %d vertices were imported."),
			MinX, MaxX, MinY, MaxY, Desc.SizeX, Desc.SizeY);
	}

	// Step 7. World Partition: the whole landscape is imported first and split into streaming proxies afterwards.
	// [E] ULandscapeSubsystem::IsGridBased() and ChangeGridSize(ULandscapeInfo*, uint32 NewGridSizeInComponents).
	// [U] That the subsystem is reached through the world, and that a grid-based world is a World Partition one.
	// OPEN QUESTION: whether a landscape larger than the region size must be created region by region instead.
	if (Desc.PartitionGridSize > 0)
	{
		ULandscapeSubsystem* LandscapeSubsystem = World->GetSubsystem<ULandscapeSubsystem>();
		if (LandscapeSubsystem != nullptr && LandscapeSubsystem->IsGridBased())
		{
			LandscapeSubsystem->ChangeGridSize(LandscapeInfo, static_cast<uint32>(Desc.PartitionGridSize));
		}
	}

	// Step 8.
	// [U] From the research's sketch. OPEN QUESTION: whether FActorLabelUtilities is still declared by Editor.h.
	FActorLabelUtilities::SetActorLabelUnique(Landscape, Desc.Label);

	UE_LOG(LogOrogenBridge, Log, TEXT("Created the landscape %s: %d x %d vertices, %d target layers."), *Desc.Label, Desc.SizeX, Desc.SizeY, Desc.Layers.Num());
	return Landscape;
}
